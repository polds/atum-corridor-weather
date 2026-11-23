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
			canaryCron: "2,7,12,17,22,27,32,37,42,47,52,57 * * * *",
			alertWebhook: null,
			alertMinSeverity: "critical",
			publicUrl: null,
		});
	});

	it("refuses mainnet without the acknowledgement", () => {
		const mainnet = {
			NETWORK: "mainnet",
			GATEWAY_URL: "https://payment-gw.production-mainnet.atum.xyz",
		};
		expect(parse(mainnet)).toMatchObject({
			ok: false,
			errors: [expect.stringMatching(/^MAINNET_ACK: NETWORK=mainnet needs MAINNET_ACK=/)],
		});
		expect(parse({ ...mainnet, MAINNET_ACK: "yes" }).ok).toBe(false);
		expect(parse({ ...mainnet, MAINNET_ACK })).toMatchObject({
			ok: true,
			config: { network: "mainnet" },
		});
	});

	it("accepts only the network's own gateway or a loopback gateway", () => {
		const mainnet = { NETWORK: "mainnet", MAINNET_ACK };
		for (const ok of [
			{ GATEWAY_URL: "https://payment-gw.production-testnet.atum.xyz" },
			{ GATEWAY_URL: "https://payment-gw.production-testnet.atum.xyz/" },
			{ ...mainnet, GATEWAY_URL: "https://payment-gw.production-mainnet.atum.xyz" },
			{ GATEWAY_URL: "http://127.0.0.1:8789" },
			{ GATEWAY_URL: "http://localhost:8789" },
			{ GATEWAY_URL: "http://[::1]:8789" },
		]) {
			expect(parse(ok).ok).toBe(true);
		}
		for (const bad of [
			{ GATEWAY_URL: "https://payment-gw.production-mainnet.atum.xyz" },
			{ ...mainnet, GATEWAY_URL: "https://payment-gw.production-testnet.atum.xyz" },
			{ GATEWAY_URL: "https://gateway.example" },
			{ GATEWAY_URL: "http://payment-gw.production-testnet.atum.xyz" },
			{ GATEWAY_URL: "https://payment-gw.production-testnet.atum.xyz/v1" },
			{ GATEWAY_URL: "https://127.0.0.1:8789" },
			{ GATEWAY_URL: "http://127.0.0.2:8789" },
			{ GATEWAY_URL: "not a url" },
		]) {
			expect(parse(bad)).toMatchObject({
				ok: false,
				errors: [expect.stringMatching(/^GATEWAY_URL: /)],
			});
		}
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

	it("bounds tier amounts to what a token can represent", () => {
		const tier = (amount: string) => parse({ AMOUNT_TIERS: JSON.stringify({ small: amount }) });
		for (const good of ["0.000000000000000001", "1.5000000000000000000", "9".repeat(24)]) {
			expect(tier(good).ok).toBe(true);
		}
		for (const bad of ["0.000", "0.0000000000000000001", "1".repeat(25)]) {
			expect(tier(bad)).toMatchObject({
				ok: false,
				errors: [expect.stringMatching(/^AMOUNT_TIERS\.small: /)],
			});
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
	it("requires the canary cron", () => {
		for (const bad of [{ CANARY_CRON: "" }, { CANARY_CRON: undefined }]) {
			expect(parse(bad)).toMatchObject({
				ok: false,
				errors: [expect.stringMatching(/^CANARY_CRON: /)],
			});
		}
	});

	it("accepts an https webhook, or http on a loopback host, with a format", () => {
		expect(parse({ ALERT_WEBHOOK_URL: "https://hooks.example.test/T0/B0/x" })).toMatchObject({
			ok: true,
			config: { alertWebhook: { url: "https://hooks.example.test/T0/B0/x", format: "slack" } },
		});
		expect(
			parse({ ALERT_WEBHOOK_URL: "http://127.0.0.1:9000/hook", ALERT_WEBHOOK_FORMAT: "json" }),
		).toMatchObject({
			ok: true,
			config: { alertWebhook: { url: "http://127.0.0.1:9000/hook", format: "json" } },
		});
		for (const loopback of ["http://localhost:9000/hook", "http://[::1]:9000/hook"]) {
			expect(parse({ ALERT_WEBHOOK_URL: loopback }).ok).toBe(true);
		}
		expect(parse({ ALERT_WEBHOOK_URL: "" })).toMatchObject({
			ok: true,
			config: { alertWebhook: null },
		});
		expect(parse({ ALERT_WEBHOOK_FORMAT: "teams" }).ok).toBe(false);
	});

	it("rejects any other webhook URL without quoting it", () => {
		for (const bad of [
			"http://hooks.example.test/secret-token",
			"ftp://hooks.example.test/secret-token",
			"http://127.0.0.2/secret-token",
			"secret-token",
		]) {
			const result = parse({ ALERT_WEBHOOK_URL: bad });
			expect(result).toMatchObject({
				ok: false,
				errors: [expect.stringMatching(/^ALERT_WEBHOOK_URL: /)],
			});
			expect(JSON.stringify(result)).not.toContain("secret-token");
		}
	});

	it("reads the minimum severity", () => {
		expect(parse({ ALERT_MIN_SEVERITY: "warning" })).toMatchObject({
			ok: true,
			config: { alertMinSeverity: "warning" },
		});
		expect(parse({ ALERT_MIN_SEVERITY: undefined })).toMatchObject({
			ok: true,
			config: { alertMinSeverity: "critical" },
		});
		expect(parse({ ALERT_MIN_SEVERITY: "info" }).ok).toBe(false);
	});

	it("keeps the public URL as origin and path with no trailing slash", () => {
		for (const [value, expected] of [
			["https://weather.example", "https://weather.example"],
			["https://weather.example/", "https://weather.example"],
			["https://weather.example/cw//", "https://weather.example/cw"],
			["http://127.0.0.1:8787/", "http://127.0.0.1:8787"],
			["", null],
		] as const) {
			expect(parse({ PUBLIC_URL: value })).toMatchObject({
				ok: true,
				config: { publicUrl: expected },
			});
		}
		for (const bad of [
			"http://weather.example",
			"https://weather.example/?a=1",
			"https://weather.example/#top",
			"not a url",
		]) {
			expect(parse({ PUBLIC_URL: bad })).toMatchObject({
				ok: false,
				errors: [expect.stringMatching(/^PUBLIC_URL: /)],
			});
		}
	});
});
