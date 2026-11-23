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
import { errorText, type GatewayClient, type GatewayFailure } from "./client";
import { buildQuoteRequestFromListing, type QuoteRequestError } from "./quote-request";
import type { StatusResponse } from "./schemas";

/** The `code` of a probe that hit HTTP 429. The tick stops on it. */
export const RATE_LIMITED_CODE = "RATE_LIMIT_EXCEEDED";

/** The `code` of a probe whose request the Workers platform refused. The tick stops on it. */
export const SUBREQUEST_LIMIT_CODE = "SUBREQUEST_LIMIT";

/**
 * How long after the quote deadline the last poll goes out. The gateway closes
 * the batch by its own clock, so the margin has to cover the difference between
 * the two clocks. It costs time, not requests.
 */
export const LAST_POLL_MARGIN_MS = 500;

/**
 * Polls sent every `pollIntervalMs` while the next one would still fall before
 * the quote deadline, counted from the create call: `k * pollIntervalMs < window`.
 */
function intervalPolls(params: {
	readonly quoteWindowSeconds: number;
	readonly pollIntervalMs: number;
}): number {
	return Math.ceil((params.quoteWindowSeconds * 1000) / params.pollIntervalMs) - 1;
}

/**
 * The most requests one probe sends: the create call, the interval polls and
 * the last poll after the deadline. `runProbe` never sends more, whatever the
 * gateway answers and however slowly.
 */
export function requestsPerProbe(params: {
	readonly quoteWindowSeconds: number;
	readonly pollIntervalMs: number;
}): number {
	return 1 + intervalPolls(params) + 1;
}

/**
 * Whether a transport failure is the Workers platform refusing the request for
 * passing the subrequest limit. Cloudflare's text is believed to be "Too many
 * subrequests." That is unverified: the limit cannot be reproduced locally.
 */
function isSubrequestRefusal(failure: GatewayFailure): boolean {
	return failure.kind === "transport" && /subrequest/i.test(failure.message);
}

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

export function isSubrequestLimited(
	outcome: ProbeOutcome,
): outcome is Extract<ProbeOutcome, { readonly kind: "gateway_error" }> {
	return outcome.kind === "gateway_error" && outcome.code === SUBREQUEST_LIMIT_CODE;
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
				code: isSubrequestRefusal(failure) ? SUBREQUEST_LIMIT_CODE : null,
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
				retryClassification: decline.retry_classification,
				count: decline.count,
			})) ?? null,
		requestedCount: status.requested_count ?? null,
	};
}

/**
 * Opens one quote request with `wait=false` and polls it on a fixed schedule:
 * every `pollIntervalMs` while the next poll would still fall before the quote
 * deadline the request set, then once `LAST_POLL_MARGIN_MS` after it. It stops
 * at the first answer that is not `collecting`, and sends at most
 * `requestsPerProbe` requests. Every failure becomes a `gateway_error`
 * outcome; this function never throws.
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

	const noTimings: ProbeTimings = { createLatencyMs: null, firstQuoteMs: null, readyMs: null };
	try {
		const build = buildQuoteRequestFromListing({
			target: plan.target,
			listing: plan.listing,
			identity: plan.identity,
			requestId: plan.id,
			nowMs: startedMs,
			quoteWindowSeconds: deps.quoteWindowSeconds,
		});
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
			return record(
				gatewayError("create", created.failure),
				{ ...noTimings, createLatencyMs },
				null,
			);
		}
		const batch = {
			quoteRequestId: created.value.quote_request_id,
			idempotentReplay: created.value.idempotent_replay,
		};

		const deadlineMs = Date.parse(build.body.quote_deadline);
		const firstSeenMs = new Map<string, number>();
		let firstQuoteMs: number | null = null;
		let readyMs: number | null = null;
		// The counter bounds the requests. The clock can only make the last poll come sooner.
		let intervalPollsLeft = intervalPolls(deps);
		for (;;) {
			const last = intervalPollsLeft === 0 || deps.now() + deps.pollIntervalMs >= deadlineMs;
			intervalPollsLeft -= 1;
			await deps.sleep(
				last ? Math.max(0, deadlineMs + LAST_POLL_MARGIN_MS - deps.now()) : deps.pollIntervalMs,
			);
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
			if (status.status !== "collecting" || last) {
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
	} catch (error) {
		// A step that throws ends this probe, never the tick.
		const phase = raw.length === 0 ? "create" : "poll";
		const message = `probe failed: ${errorText(error)}`;
		return record(
			{ kind: "gateway_error", phase, httpStatus: null, code: null, message },
			noTimings,
			null,
		);
	}
}
