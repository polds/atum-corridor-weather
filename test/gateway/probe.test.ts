import { describe, expect, it } from "vitest";
import { PROBE_IDENTITY } from "../../src/domain/identity";
import { probeTargets, slotAt } from "../../src/domain/schedule";
import type { ProbeIdentity } from "../../src/domain/types";
import { createGatewayClient, type GatewayClient } from "../../src/gateway/client";
import { isRateLimited, type ProbePlan, runProbe } from "../../src/gateway/probe";
import {
	FakeClock,
	type Handler,
	jsonResponse,
	replay,
	scriptedFetch,
} from "../support/fake-gateway";
import {
	ARB_TO_BASE_USDC,
	corridorById,
	fixtures,
	type ProbeFixture,
	testnetListing,
} from "../support/fixtures";
import { probeIdOf } from "../support/ids";

/** When the quoted fixture's create call was sent. */
const START = Date.parse("2026-11-22T10:37:05.617Z");
const QR = "qr_01a202d4-bb03-7340-93a0-c945aa0f7b23";
const [target] = probeTargets([corridorById(ARB_TO_BASE_USDC)], { small: "1" });

function probe(
	handler: (clock: FakeClock) => Handler,
	options: {
		readonly timeoutMs?: number;
		readonly identity?: ProbeIdentity;
		readonly wrap?: (client: GatewayClient) => GatewayClient;
	} = {},
) {
	if (target === undefined) throw new Error("no target");
	const clock = new FakeClock(START);
	const fake = scriptedFetch(handler(clock));
	const plan: ProbePlan = {
		id: probeIdOf("cw1.testnet.20261122T1035Z.7ae33acb9dd6.small"),
		slot: slotAt({ network: "testnet", epochMs: START, intervalMinutes: 5 }),
		target,
		listing: testnetListing,
		identity: options.identity ?? PROBE_IDENTITY,
	};
	const client = createGatewayClient({
		baseUrl: "https://gateway.test",
		userAgent: "corridor-weather/test",
		fetch: fake.fetch,
		now: clock.now,
		timeoutMs: options.timeoutMs ?? 1000,
	});
	const run = runProbe(plan, {
		gateway: options.wrap?.(client) ?? client,
		now: clock.now,
		sleep: clock.sleep,
		pollIntervalMs: 500,
		quoteWindowSeconds: 3,
	});
	return { run, requests: fake.requests };
}

/** The fixture with every poll rewritten by `edit`. */
function withPolls(fixture: ProbeFixture, edit: (json: object) => object): ProbeFixture {
	return {
		body: fixture.body,
		events: fixture.events.map((event, index) =>
			index === 0 || typeof event.json !== "object" || event.json === null
				? event
				: { ...event, json: edit(event.json) },
		),
	};
}

/** Answers the create call from `fixture` and every poll with `poll`. */
function createThen(poll: Handler): (clock: FakeClock) => Handler {
	return (clock) => {
		const created = replay(fixtures.quoted, clock);
		return (request) => (request.method === "POST" ? created(request) : poll(request));
	};
}

describe("runProbe", () => {
	it("records a quoted probe with its timings from the quoted fixture", async () => {
		const { run, requests } = probe((clock) => replay(fixtures.quoted, clock));
		const record = await run;
		expect(record.outcome).toStrictEqual({
			kind: "quoted",
			quotes: [
				{
					quoteId: "0x42a8cbd8c55960824a42986ce7b3eabc0489963608bfab00b63066fc9a774913",
					settlerAddress: "0x0eee42ec90eb7d1e53504fb508790e410a286a11",
					sourceAmount: "1000200",
					awardDeadline: "2026-11-22T10:38:05.812Z",
					spreadBps: 2,
					priceHoldMs: 59_601,
				},
			],
			declines: [],
			requestedCount: 1,
		});
		expect(record.timings).toStrictEqual({ createLatencyMs: 64, firstQuoteMs: 594, readyMs: 3232 });
		expect(record).toMatchObject({
			startedAt: "2026-11-22T10:37:05.617Z",
			quoteRequestId: QR,
			idempotentReplay: false,
		});
		expect(requests.map((request) => request.method)).toStrictEqual([
			"POST",
			...Array<string>(6).fill("GET"),
		]);
		expect(record.raw).toHaveLength(7);
	});

	it("sends one quote request body built for the probe and nothing that spends", async () => {
		const { run, requests } = probe((clock) => replay(fixtures.quoted, clock));
		await run;
		const [create] = requests;
		expect(create?.url.pathname).toBe("/v1/payments/quote-requests");
		expect(create?.url.searchParams.get("wait")).toBe("false");
		expect(create?.body).toMatchObject({
			request_id: "cw1.testnet.20261122T1035Z.7ae33acb9dd6.small",
			quote_selector: PROBE_IDENTITY.eip155,
			fulfillment_amount: "1000000",
		});
		expect(create?.body).not.toHaveProperty("sender_auth");
		expect(requests.slice(1).every((request) => request.url.pathname.endsWith(QR))).toBe(true);
	});

	it.each([
		["insufficient liquidity", fixtures.declinedLiquidity, "INSUFFICIENT_LIQUIDITY", 3246],
		["internal", fixtures.declinedInternal, "INTERNAL", 3213],
	] as const)("records a declined probe (%s)", async (_name, fixture, reason, readyMs) => {
		const record = await probe((clock) => replay(fixture, clock)).run;
		expect(record.outcome).toStrictEqual({
			kind: "declined",
			declines: [{ reason, retryClassification: "RETRY_AFTER_DELAY", count: 1 }],
			requestedCount: 1,
		});
		expect(record.timings.firstQuoteMs).toBeNull();
		expect(record.timings.readyMs).toBe(readyMs);
	});

	it("records a silent probe when nobody quoted or declined", async () => {
		const silent = withPolls(fixtures.declinedLiquidity, (json) => ({
			...json,
			decline_summary: [],
		}));
		const record = await probe((clock) => replay(silent, clock)).run;
		expect(record.outcome).toStrictEqual({ kind: "silent", requestedCount: 1 });

		const unknownCount = withPolls(fixtures.declinedLiquidity, (json) => {
			const {
				requested_count: _,
				decline_summary: __,
				...rest
			} = { requested_count: 0, decline_summary: [], ...json };
			return rest;
		});
		const unknown = await probe((clock) => replay(unknownCount, clock)).run;
		expect(unknown.outcome).toStrictEqual({ kind: "silent", requestedCount: null });
	});

	it("records an incomplete probe when the batch is still collecting after the window", async () => {
		const stuck = withPolls(fixtures.quoted, (json) => ({ ...json, status: "collecting" }));
		const { run, requests } = probe((clock) => replay(stuck, clock));
		const record = await run;
		expect(record.outcome).toStrictEqual({ kind: "incomplete" });
		expect(record.timings).toStrictEqual({ createLatencyMs: 64, firstQuoteMs: 594, readyMs: null });
		expect(requests.length).toBeGreaterThan(7);
		expect(record.raw.at(-1)?.at).toBe("2026-11-22T10:37:11.849Z");
	});

	it("records a gateway error for a non-JSON 500 on a poll", async () => {
		const record = await probe(createThen(() => new Response("<html>oops</html>", { status: 500 })))
			.run;
		expect(record.outcome).toStrictEqual({
			kind: "gateway_error",
			phase: "poll",
			httpStatus: 500,
			code: null,
			message: "<html>oops</html>",
		});
		expect(record.quoteRequestId).toBe(QR);
		expect(record.raw[1]).toMatchObject({ status: 500, responseBody: "<html>oops</html>" });
	});

	it("marks HTTP 429 so the tick can stop", async () => {
		const record = await probe(
			() => () => jsonResponse(429, { code: "RATE_LIMIT_EXCEEDED", message: "Too many requests" }),
		).run;
		expect(record.outcome).toStrictEqual({
			kind: "gateway_error",
			phase: "create",
			httpStatus: 429,
			code: "RATE_LIMIT_EXCEEDED",
			message: "Too many requests",
		});
		expect(isRateLimited(record.outcome)).toBe(true);

		const bare = await probe(createThen(() => new Response(null, { status: 429 }))).run;
		expect(bare.outcome).toMatchObject({
			phase: "poll",
			httpStatus: 429,
			code: "RATE_LIMIT_EXCEEDED",
		});
		expect(isRateLimited(bare.outcome)).toBe(true);
	});

	it("records a gateway error when the network throws", async () => {
		const record = await probe(() => () => {
			throw new TypeError("connection refused");
		}).run;
		expect(record.outcome).toStrictEqual({
			kind: "gateway_error",
			phase: "create",
			httpStatus: null,
			code: null,
			message: "transport: TypeError: connection refused",
		});
		expect(record.timings.createLatencyMs).toBeNull();
		expect(isRateLimited(record.outcome)).toBe(false);
	});

	it("records a gateway error when a poll times out", async () => {
		const record = await probe(
			createThen(() => new Promise<Response>(() => {})),
			{
				timeoutMs: 20,
			},
		).run;
		expect(record.outcome).toMatchObject({
			kind: "gateway_error",
			phase: "poll",
			httpStatus: null,
			code: null,
		});
		expect(record.outcome).toHaveProperty("message", expect.stringMatching(/^timeout: /));
	});

	it("records a gateway error instead of throwing when a step throws", async () => {
		const record = await probe((clock) => replay(fixtures.quoted, clock), {
			wrap: (client) => ({
				...client,
				getQuoteRequest: () => {
					throw new URIError("URI malformed");
				},
			}),
		}).run;
		expect(record.outcome).toStrictEqual({
			kind: "gateway_error",
			phase: "poll",
			httpStatus: null,
			code: null,
			message: "probe failed: URIError: URI malformed",
		});
		expect(record.raw).toHaveLength(1);
	});

	it("records a gateway error and sends nothing when the body cannot be built", async () => {
		const gatewaySelector = testnetListing["eip155:421614"]?.quote_selector ?? "";
		const { run, requests } = probe((clock) => replay(fixtures.quoted, clock), {
			identity: { ...PROBE_IDENTITY, eip155: gatewaySelector },
		});
		const record = await run;
		expect(requests).toHaveLength(0);
		expect(record.outcome).toStrictEqual({
			kind: "gateway_error",
			phase: "create",
			httpStatus: null,
			code: null,
			message: `request not sent: quote_selector ${gatewaySelector} is the gateway's own selector`,
		});
		expect(record.raw).toStrictEqual([]);
	});

	it("reports an unexpected create response as a gateway error", async () => {
		const record = await probe(() => () => jsonResponse(202, { status: "collecting" })).run;
		expect(record.outcome).toMatchObject({
			kind: "gateway_error",
			phase: "create",
			httpStatus: 202,
			message: "unexpected response: quote_request_id: Required",
		});
	});
});
