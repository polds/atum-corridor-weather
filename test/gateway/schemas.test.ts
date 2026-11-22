import { describe, expect, it } from "vitest";
import {
	createResponseSchema,
	defaultsListingSchema,
	describeError,
	statusResponseSchema,
} from "../../src/gateway/schemas";
import { fixtures, type ProbeFixture } from "../support/fixtures";

const probeFixtures: [string, ProbeFixture][] = [
	["quoted", fixtures.quoted],
	["declined-insufficient-liquidity", fixtures.declinedLiquidity],
	["declined-internal", fixtures.declinedInternal],
];

describe("defaults listing schema", () => {
	it("parses the testnet listing with every chain and token", () => {
		const listing = defaultsListingSchema.parse(fixtures.testnetDefaults);
		expect(Object.keys(listing)).toHaveLength(10);
		expect(listing["tron:shasta"]).toStrictEqual({
			escrow_contract: "TNW6knfy7gD5W8meUAj9cdqpjFZVHN4vUw",
			quote_selector: "TV1yfS3LQAPpNqSr1cL3C4L4551atNyuih",
			fulfillment_proxy: "TH88i2DKyLwjtH8hMzXTqSzGLr7U6eprbZ",
			fulfillment_verifier: {
				account: "TV1yfS3LQAPpNqSr1cL3C4L4551atNyuih",
				endpoint: "https://veri-fill-382477456811.us-central1.run.app",
			},
			tokens: [
				{ address: "TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs", decimals: 6, symbol: "USDT" },
				{ address: "TSdZwNqpHofzP6BsBKGQUWdBeJphLmF6id", decimals: 6, symbol: "USDC" },
			],
		});
	});

	it("parses the mainnet listing", () => {
		const listing = defaultsListingSchema.parse(fixtures.mainnetDefaults);
		expect(Object.keys(listing)).toHaveLength(10);
		expect(listing["eip155:1"]?.tokens.map((token) => token.symbol)).toContain("WETH");
	});

	it("drops a malformed chain or token and keeps the rest", () => {
		const listing = defaultsListingSchema.parse({
			"eip155:1": {
				chain_id: "eip155:1",
				escrow_contract: "0xe",
				tokens: [
					{ address: "0xa", decimals: 6, symbol: "USDC" },
					{ address: "0xb", symbol: "USDT" },
				],
			},
			"eip155:2": "not a chain",
		});
		expect(Object.keys(listing)).toStrictEqual(["eip155:1"]);
		expect(listing["eip155:1"]?.tokens).toStrictEqual([
			{ address: "0xa", decimals: 6, symbol: "USDC" },
		]);
		expect(listing["eip155:1"]?.quote_selector).toBe("");
	});
});

describe.each(probeFixtures)("probe fixture %s", (_name, fixture) => {
	it("parses the 202 create response", () => {
		const [created] = fixture.events;
		expect(created?.status).toBe(202);
		const parsed = createResponseSchema.parse(created?.json);
		expect(parsed.status).toBe("collecting");
		expect(parsed.idempotent_replay).toBe(false);
		expect(parsed.quote_request_id).toMatch(/^qr_/);
	});

	it("parses every status poll", () => {
		for (const event of fixture.events.slice(1)) {
			const parsed = statusResponseSchema.parse(event.json);
			expect(parsed.requested_count).toBe(1);
			expect(["collecting", "ready"]).toContain(parsed.status);
		}
	});
});

describe("status response schema", () => {
	it("reads the quote fields the probe needs", () => {
		const parsed = statusResponseSchema.parse(fixtures.quoted.events[1]?.json);
		expect(parsed.quotes).toStrictEqual([
			{
				quote_id: "0x42a8cbd8c55960824a42986ce7b3eabc0489963608bfab00b63066fc9a774913",
				fulfillment_quote: {
					settler_address: "0x0eee42ec90eb7d1e53504fb508790e410a286a11",
					source_amount: "1000200",
					award_deadline: "2026-11-22T10:38:05.812Z",
				},
			},
		]);
	});

	it("keeps an unknown status, an unknown reason, and an absent requested_count", () => {
		const parsed = statusResponseSchema.parse({
			quote_request_id: "qr_x",
			status: "paused",
			decline_summary: [{ reason: "NEW_REASON", count: 2 }],
		});
		expect(parsed).toStrictEqual({
			quote_request_id: "qr_x",
			status: "paused",
			quotes: [],
			decline_summary: [{ reason: "NEW_REASON", count: 2 }],
		});
		expect(parsed.requested_count).toBeUndefined();
	});

	it("normalizes an award deadline to millisecond UTC and rejects a non-timestamp", () => {
		const quote = (deadline: string) => ({
			quote_request_id: "qr_x",
			status: "ready",
			quotes: [
				{
					quote_id: "q",
					fulfillment_quote: {
						settler_address: "0x1",
						source_amount: "5",
						award_deadline: deadline,
					},
				},
			],
		});
		const parsed = statusResponseSchema.parse(quote("2026-11-22T10:38:05Z"));
		expect(parsed.quotes[0]?.fulfillment_quote.award_deadline).toBe("2026-11-22T10:38:05.000Z");
		expect(statusResponseSchema.safeParse(quote("soon")).success).toBe(false);
	});
});

describe("describeError", () => {
	it("reads a public error", () => {
		expect(
			describeError({
				code: "RATE_LIMIT_EXCEEDED",
				message: "slow down",
				retry_classification: "X",
			}),
		).toStrictEqual({ code: "RATE_LIMIT_EXCEEDED", message: "slow down" });
	});
	it("reads a panic body", () => {
		expect(describeError({ error: "Internal server error occurred" })).toStrictEqual({
			code: null,
			message: "Internal server error occurred",
		});
	});
	it("keeps text and handles no body", () => {
		expect(describeError("<html>bad gateway</html>")).toStrictEqual({
			code: null,
			message: "<html>bad gateway</html>",
		});
		expect(describeError(null)).toStrictEqual({ code: null, message: "no error body" });
	});
});
