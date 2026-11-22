import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAINNET_ACK, parseConfig } from "../../src/worker/config";

const parse = (overrides: Readonly<Record<string, string | undefined>>) =>
	parseConfig({ ...env, ...overrides });

describe("parseConfig", () => {
	it("reads the deployed wrangler.jsonc variables", () => {
		const result = parseConfig(env);
		if (!result.ok) throw new Error(result.errors.join("; "));
		expect(result.config).toStrictEqual({
			network: "testnet",
			gatewayUrl: "https://payment-gw.production-testnet.atum.xyz",
			repositoryUrl: "https://github.com/polds/atum-corridor-weather",
			probeEnabled: true,
			tickIntervalMinutes: 5,
			probesPerTick: 30,
			tierAmounts: { small: "1", typical: "25", large: "100" },
			pollIntervalMs: 500,
			quoteWindowSeconds: 3,
			slowQuoteMs: 2500,
			corridorFilter: null,
			rawRetentionDays: 14,
		});
	});

	it("refuses mainnet without the acknowledgement", () => {
		expect(parse({ NETWORK: "mainnet" })).toMatchObject({
			ok: false,
			errors: [expect.stringMatching(/^MAINNET_ACK: NETWORK=mainnet needs MAINNET_ACK=/)],
		});
		expect(parse({ NETWORK: "mainnet", MAINNET_ACK: "yes" }).ok).toBe(false);
		expect(parse({ NETWORK: "mainnet", MAINNET_ACK })).toMatchObject({
			ok: true,
			config: { network: "mainnet" },
		});
	});

	it("compiles a corridor filter and rejects an invalid one", () => {
		const result = parse({ CORRIDOR_FILTER: "^tron:" });
		expect(result.ok && result.config.corridorFilter?.test("tron:shasta/USDT>x")).toBe(true);
		expect(parse({ CORRIDOR_FILTER: "([" })).toMatchObject({
			ok: false,
			errors: ["CORRIDOR_FILTER: must be a valid regular expression"],
		});
	});

	it("accepts a subset of tiers and rejects bad tier amounts", () => {
		expect(parse({ AMOUNT_TIERS: '{"small":"0.5"}' })).toMatchObject({
			ok: true,
			config: { tierAmounts: { small: "0.5" } },
		});
		for (const bad of [
			'{"huge":"1"}',
			'{"small":"0"}',
			'{"small":"-1"}',
			"{}",
			"not json",
			'{"small":1}',
		]) {
			expect(parse({ AMOUNT_TIERS: bad }).ok).toBe(false);
		}
	});

	it("bounds the numeric settings", () => {
		expect(parse({ PROBES_PER_TICK: "200" }).ok).toBe(true);
		for (const bad of ["0", "201", "1.5", "ten", ""]) {
			expect(parse({ PROBES_PER_TICK: bad }).ok).toBe(false);
		}
		expect(parse({ POLL_INTERVAL_MS: "50" }).ok).toBe(false);
		expect(parse({ PROBE_ENABLED: "yes" }).ok).toBe(false);
		expect(parse({ GATEWAY_URL: "ftp://gateway.example" }).ok).toBe(false);
		expect(parse({ RAW_RETENTION_DAYS: "0" })).toMatchObject({
			ok: true,
			config: { rawRetentionDays: 0 },
		});
	});
});
