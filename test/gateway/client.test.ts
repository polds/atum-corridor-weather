import { describe, expect, it } from "vitest";
import { createGatewayClient, type GatewayClient, userAgent } from "../../src/gateway/client";
import { FakeClock, type Handler, jsonResponse, scriptedFetch } from "../support/fake-gateway";
import { fixtures } from "../support/fixtures";

const START = Date.parse("2026-11-22T10:35:00.000Z");

function client(handler: Handler, timeoutMs = 1000) {
	const clock = new FakeClock(START);
	const fake = scriptedFetch(handler);
	const gateway: GatewayClient = createGatewayClient({
		baseUrl: "https://gateway.test",
		userAgent: userAgent("0.1.0", "https://github.com/example/corridor-weather"),
		fetch: fake.fetch,
		now: clock.now,
		timeoutMs,
	});
	return { gateway, requests: fake.requests };
}

describe("route allowlist", () => {
	it.each([
		["POST", "/v1/payments/awards"],
		["POST", "/v1/payments"],
		["GET", "/v1/payments/pay_123"],
		["POST", "/v1/defaults"],
		["GET", "/v1/payments/quote-requests"],
		["GET", "/v1/payments/quote-requests/.."],
		["GET", "//evil.test/v1/defaults"],
	] as const)("refuses %s %s before sending", async (method, path) => {
		const { gateway, requests } = client(() => jsonResponse(200, {}));
		const result = await gateway.send({ method, path });
		expect(requests).toHaveLength(0);
		expect(result.ok).toBe(false);
		expect(result).toMatchObject({ failure: { kind: "refused" }, exchange: { status: null } });
	});

	it("refuses a quote request body that carries sender_auth", async () => {
		const { gateway, requests } = client(() => jsonResponse(202, {}));
		const result = await gateway.send({
			method: "POST",
			path: "/v1/payments/quote-requests",
			body: { request_id: "x", sender_auth: { signature: "0x" } },
		});
		expect(requests).toHaveLength(0);
		expect(result).toMatchObject({ ok: false, failure: { kind: "refused" } });
	});

	it("sends the three allowed routes with a synthetic-probe user agent", async () => {
		const { gateway, requests } = client((request) =>
			request.url.pathname === "/v1/defaults"
				? jsonResponse(200, fixtures.testnetDefaults)
				: request.method === "POST"
					? jsonResponse(202, fixtures.quoted.events[0]?.json)
					: jsonResponse(200, fixtures.quoted.events[1]?.json),
		);
		expect((await gateway.getDefaults()).ok).toBe(true);
		expect(
			(await gateway.send({ method: "POST", path: "/v1/payments/quote-requests", body: {} })).ok,
		).toBe(true);
		expect((await gateway.getQuoteRequest("qr_01a202d4-bb03-7340-93a0-c945aa0f7b23")).ok).toBe(
			true,
		);
		expect(requests.map((request) => `${request.method} ${request.url.pathname}`)).toStrictEqual([
			"GET /v1/defaults",
			"POST /v1/payments/quote-requests",
			"GET /v1/payments/quote-requests/qr_01a202d4-bb03-7340-93a0-c945aa0f7b23",
		]);
		expect(requests[0]?.headers.get("user-agent")).toBe(
			"corridor-weather/0.1.0 (+https://github.com/example/corridor-weather; synthetic probe)",
		);
	});
});

describe("results", () => {
	it("records the raw exchange of a successful call", async () => {
		const { gateway } = client(() => jsonResponse(200, fixtures.quoted.events[1]?.json));
		const result = await gateway.getQuoteRequest("qr_1");
		expect(result.exchange).toMatchObject({
			at: "2026-11-22T10:35:00.000Z",
			method: "GET",
			path: "/v1/payments/quote-requests/qr_1",
			requestBody: null,
			status: 200,
			latencyMs: 0,
			error: null,
		});
		expect(result.exchange.responseBody).toStrictEqual(fixtures.quoted.events[1]?.json);
	});

	it("keeps a non-JSON 500 body as text", async () => {
		const { gateway } = client(() => new Response("upstream exploded", { status: 500 }));
		const result = await gateway.getQuoteRequest("qr_1");
		expect(result).toMatchObject({
			ok: false,
			failure: { kind: "http", status: 500, code: null, message: "upstream exploded" },
			exchange: { status: 500, responseBody: "upstream exploded" },
		});
	});

	it("reads the code of a public error", async () => {
		const { gateway } = client(() =>
			jsonResponse(429, { code: "RATE_LIMIT_EXCEEDED", message: "too many requests" }),
		);
		const result = await gateway.getDefaults();
		expect(result).toMatchObject({
			ok: false,
			failure: { kind: "http", status: 429, code: "RATE_LIMIT_EXCEEDED" },
		});
	});

	it("reports a response that does not match the schema", async () => {
		const { gateway } = client(() => jsonResponse(200, { status: "ready" }));
		const result = await gateway.getQuoteRequest("qr_1");
		expect(result).toMatchObject({
			ok: false,
			failure: { kind: "invalid_response", status: 200 },
			exchange: { error: "unexpected response: quote_request_id: Required" },
		});
	});

	it("turns a thrown fetch into a transport failure", async () => {
		const { gateway } = client(() => {
			throw new TypeError("network is down");
		});
		const result = await gateway.getDefaults();
		expect(result).toMatchObject({
			ok: false,
			failure: { kind: "transport", message: "TypeError: network is down" },
			exchange: { status: null, error: "TypeError: network is down" },
		});
	});

	it("never follows a redirect and records it as an http failure", async () => {
		const inits: (RequestInit | undefined)[] = [];
		const gateway = createGatewayClient({
			baseUrl: "https://gateway.test",
			userAgent: "corridor-weather/test",
			fetch: async (_input, init) => {
				inits.push(init);
				return new Response(null, { status: 307, headers: { location: "/v1/payments/awards" } });
			},
			now: () => START,
			timeoutMs: 1000,
		});
		const result = await gateway.getDefaults();
		expect(inits.map((init) => init?.redirect)).toStrictEqual(["manual"]);
		expect(result).toMatchObject({
			ok: false,
			failure: {
				kind: "http",
				status: 307,
				message: "redirect to /v1/payments/awards not followed",
			},
			exchange: { path: "/v1/defaults", status: 307 },
		});
	});

	it("refuses a body over 256 KiB, declared or streamed, and keeps none of it", async () => {
		const declared = client(
			() => new Response("{}", { status: 200, headers: { "content-length": "262145" } }),
		);
		const streamed = client(() => jsonResponse(200, { pad: "x".repeat(262_144) }));
		for (const { gateway } of [declared, streamed]) {
			expect(await gateway.getDefaults()).toMatchObject({
				ok: false,
				failure: {
					kind: "invalid_response",
					status: 200,
					message: expect.stringMatching(/^response too large/),
				},
				exchange: {
					status: 200,
					responseBody: null,
					error: expect.stringMatching(/^response too large/),
				},
			});
		}
	});

	it("gives up on a call that outlives its timeout", async () => {
		const { gateway } = client(() => new Promise<Response>(() => {}), 20);
		const result = await gateway.getDefaults();
		expect(result).toMatchObject({ ok: false, failure: { kind: "timeout" } });
	});
});
