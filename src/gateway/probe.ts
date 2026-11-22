import { isoAt } from "../domain/brands";
import type { DefaultsListing } from "../domain/corridors";
import { classifyOutcome, type FinalStatus } from "../domain/outcome";
import type {
	ProbeId,
	ProbeIdentity,
	ProbeOutcome,
	ProbePhase,
	ProbeRecord,
	ProbeTarget,
	ProbeTimings,
	RawExchange,
	TickSlot,
} from "../domain/types";
import type { GatewayClient, GatewayFailure } from "./client";
import { buildQuoteRequestFromListing, type QuoteRequestError } from "./quote-request";
import type { StatusResponse } from "./schemas";

/** The `code` of a probe that hit HTTP 429. The tick stops on it. */
export const RATE_LIMITED_CODE = "RATE_LIMIT_EXCEEDED";

/** Seconds the probe keeps polling after the quote window closes. */
const POLL_GRACE_SECONDS = 3;

export interface ProbeDeps {
	readonly gateway: GatewayClient;
	/** Epoch ms. */
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly pollIntervalMs: number;
	readonly quoteWindowSeconds: number;
}

export interface ProbePlan {
	readonly id: ProbeId;
	readonly slot: TickSlot;
	readonly target: ProbeTarget;
	readonly listing: DefaultsListing;
	readonly identity: ProbeIdentity;
}

export function isRateLimited(outcome: ProbeOutcome): boolean {
	return outcome.kind === "gateway_error" && outcome.code === RATE_LIMITED_CODE;
}

function gatewayError(phase: ProbePhase, failure: GatewayFailure): ProbeOutcome {
	switch (failure.kind) {
		case "http":
			return {
				kind: "gateway_error",
				phase,
				httpStatus: failure.status,
				code: failure.status === 429 ? RATE_LIMITED_CODE : failure.code,
				message: failure.message,
			};
		case "invalid_response":
			return {
				kind: "gateway_error",
				phase,
				httpStatus: failure.status,
				code: null,
				message: failure.message,
			};
		case "refused":
		case "transport":
		case "timeout":
			return {
				kind: "gateway_error",
				phase,
				httpStatus: null,
				code: null,
				message: `${failure.kind}: ${failure.message}`,
			};
		default: {
			const exhaustive: never = failure;
			return exhaustive;
		}
	}
}

function buildErrorMessage(error: QuoteRequestError): string {
	switch (error.kind) {
		case "chain_not_listed":
			return `${error.chainId} is not in /v1/defaults`;
		case "invalid_tron_address":
			return `${error.address} is not a Tron address`;
		case "selector_is_gateway_selector":
			return `quote_selector ${error.selector} is the gateway's own selector`;
		default: {
			const exhaustive: never = error;
			return exhaustive;
		}
	}
}

/** `firstSeenMs` is null for a replayed batch, whose quotes this run did not see arrive. */
function finalStatus(
	status: StatusResponse,
	firstSeenMs: ReadonlyMap<string, number> | null,
): FinalStatus {
	return {
		status: status.status,
		quotes: status.quotes.map((quote) => ({
			quoteId: quote.quote_id,
			settlerAddress: quote.fulfillment_quote.settler_address,
			sourceAmount: quote.fulfillment_quote.source_amount,
			awardDeadline: quote.fulfillment_quote.award_deadline,
			firstSeenMs: firstSeenMs?.get(quote.quote_id) ?? null,
		})),
		declines:
			status.decline_summary?.map((decline) => ({
				reason: decline.reason,
				retryClassification: decline.retry_classification ?? null,
				count: decline.count,
			})) ?? null,
		requestedCount: status.requested_count ?? null,
	};
}

/**
 * Opens one quote request with `wait=false` and polls it until it leaves
 * `collecting` or the quote window plus a grace period has passed. Every
 * failure becomes a `gateway_error` outcome; this function never throws.
 */
export async function runProbe(plan: ProbePlan, deps: ProbeDeps): Promise<ProbeRecord> {
	const startedMs = deps.now();
	const raw: RawExchange[] = [];
	const record = (
		outcome: ProbeOutcome,
		timings: ProbeTimings,
		created: { readonly quoteRequestId: string; readonly idempotentReplay: boolean } | null,
	): ProbeRecord => ({
		id: plan.id,
		slot: plan.slot,
		target: plan.target,
		startedAt: isoAt(startedMs),
		quoteRequestId: created?.quoteRequestId ?? null,
		idempotentReplay: created?.idempotentReplay ?? false,
		outcome,
		timings,
		raw,
	});

	const build = buildQuoteRequestFromListing({
		target: plan.target,
		listing: plan.listing,
		identity: plan.identity,
		requestId: plan.id,
		nowMs: startedMs,
		quoteWindowSeconds: deps.quoteWindowSeconds,
	});
	const noTimings: ProbeTimings = { createLatencyMs: null, firstQuoteMs: null, readyMs: null };
	if (!build.ok) {
		const message = `request not sent: ${buildErrorMessage(build.error)}`;
		return record(
			{ kind: "gateway_error", phase: "create", httpStatus: null, code: null, message },
			noTimings,
			null,
		);
	}

	const sentMs = deps.now();
	const created = await deps.gateway.createQuoteRequest(build.body);
	raw.push(created.exchange);
	const createLatencyMs = created.exchange.status === null ? null : created.exchange.latencyMs;
	if (!created.ok) {
		return record(gatewayError("create", created.failure), { ...noTimings, createLatencyMs }, null);
	}
	const batch = {
		quoteRequestId: created.value.quote_request_id,
		idempotentReplay: created.value.idempotent_replay,
	};

	const budgetEndMs = sentMs + (deps.quoteWindowSeconds + POLL_GRACE_SECONDS) * 1000;
	const firstSeenMs = new Map<string, number>();
	let firstQuoteMs: number | null = null;
	let readyMs: number | null = null;
	for (;;) {
		await deps.sleep(deps.pollIntervalMs);
		const polled = await deps.gateway.getQuoteRequest(batch.quoteRequestId);
		raw.push(polled.exchange);
		const seenMs = deps.now();
		const timings = { createLatencyMs, firstQuoteMs, readyMs };
		if (!polled.ok) return record(gatewayError("poll", polled.failure), timings, batch);
		const status = polled.value;
		for (const quote of status.quotes) {
			if (!firstSeenMs.has(quote.quote_id)) firstSeenMs.set(quote.quote_id, seenMs);
		}
		if (firstQuoteMs === null && status.quotes.length > 0) firstQuoteMs = seenMs - sentMs;
		if (readyMs === null && status.status === "ready") readyMs = seenMs - sentMs;
		if (status.status !== "collecting" || seenMs >= budgetEndMs) {
			// A replayed batch was opened by an earlier run, so this run's clock measured
			// none of its timings.
			const replay = batch.idempotentReplay;
			return record(
				classifyOutcome(plan.target, finalStatus(status, replay ? null : firstSeenMs)),
				replay ? { ...noTimings, createLatencyMs } : { createLatencyMs, firstQuoteMs, readyMs },
				batch,
			);
		}
	}
}
