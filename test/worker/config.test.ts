import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAINNET_ACK, parseConfig } from "../../src/worker/config";

const parse = (overrides: Readonly<Record<string, string | undefined>>) =>
	parseConfig({ ...env, ...overrides });

describe("parseConfig", () => {
	it("accepts the committed wrangler.jsonc: testnet, with no webhook in the file", () => {
		// Nothing here pins a cadence, an amount or a threshold. Those are free to change.
		expect(parseConfig(env)).toMatchObject({
			ok: true,
			config: {
				network: "testnet",
				gatewayUrl: "https://payment-gw.production-testnet.atum.xyz",
				alertWebhook: null,
			},
		});
	});

	it("maps every variable into the config", () => {
		const result = parseConfig({
			NETWORK: "testnet",
			MAINNET_ACK: "",
			GATEWAY_URL: "https://payment-gw.production-testnet.atum.xyz",
			REPOSITORY_URL: "https://github.com/someone/corridor-weather",
			PROBE_ENABLED: "true",
			PROBES_PER_TICK: "12",
			AMOUNT_TIERS: '{"small":"1","typical":"25","large":"100"}',
			POLL_INTERVAL_MS: "500",
			QUOTE_WINDOW_SECONDS: "3",
			SLOW_QUOTE_MS: "2500",
			CORRIDOR_FILTER: "",
			RAW_RETENTION_DAYS: "14",
			PROBE_CRON: "*/15 * * * *",
			CANARY_CRON: "3,18,33,48 * * * *",
			ALERT_WEBHOOK_FORMAT: "slack",
			ALERT_MIN_SEVERITY: "critical",
			PUBLIC_URL: "",
			SUBREQUEST_LIMIT: "100",
			PUBLISH_EVERY_TICKS: "4",
		});
		if (!result.ok) throw new Error(result.errors.join("; "));
		expect(result.config).toStrictEqual({
			network: "testnet",
			gatewayUrl: "https://payment-gw.production-testnet.atum.xyz",
			repositoryUrl: "https://github.com/someone/corridor-weather",
			probeEnabled: true,
			tickIntervalMinutes: 15,
			publishEveryTicks: 4,
			publishIntervalMinutes: 60,
			probesPerTick: 12,
			subrequestLimit: 100,
			probesPlannedPerTick: 12,
			tierAmounts: { small: "1", typical: "25", large: "100" },
			pollIntervalMs: 500,
			quoteWindowSeconds: 3,
			slowQuoteMs: 2500,
			corridorFilter: null,
			rawRetentionDays: 14,
			probeCron: "*/15 * * * *",
			canaryCron: "3,18,33,48 * * * *",
			alertWebhook: null,
			alertMinSeverity: "critical",
			publicUrl: null,
		});
	});

	it("reads the tick interval from the probe cron, so the two cannot disagree", () => {
		for (const [cron, minutes] of [
			["*/10 * * * *", 10],
			["*/30 * * * *", 30],
			["0 * * * *", 60],
			["0 */6 * * *", 360],
		] as const) {
			expect(parse({ PROBE_CRON: cron }), cron).toMatchObject({
				ok: true,
				config: { tickIntervalMinutes: minutes },
			});
		}
		// A separate interval variable no longer exists, so a stale one changes nothing.
		expect(parse({ PROBE_CRON: "*/10 * * * *", TICK_INTERVAL_MINUTES: "30" })).toMatchObject({
			ok: true,
			config: { tickIntervalMinutes: 10 },
		});
	});

	it("refuses a probe cron that does not fire at one fixed interval", () => {
		for (const cron of ["*/45 * * * *", "5,35 * * * *", "0 0 * * mon", "0 9-17 * * *"]) {
			expect(parse({ PROBE_CRON: cron }), cron).toStrictEqual({
				ok: false,
				errors: [expect.stringMatching(/^PROBE_CRON: must fire at one fixed interval/)],
			});
		}
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
	it("plans the probes a tick can make within SUBREQUEST_LIMIT", () => {
		// 3 s window, 500 ms interval: 7 requests per probe, plus one for /v1/defaults and the reserve.
		const timing = { QUOTE_WINDOW_SECONDS: "3", POLL_INTERVAL_MS: "500", PROBES_PER_TICK: "30" };
		expect(parse({ ...timing, SUBREQUEST_LIMIT: undefined })).toMatchObject({
			ok: true,
			config: { probesPerTick: 30, subrequestLimit: 50, probesPlannedPerTick: 6 },
		});
		expect(parse({ ...timing, SUBREQUEST_LIMIT: "10000" })).toMatchObject({
			ok: true,
			config: { probesPerTick: 30, subrequestLimit: 10_000, probesPlannedPerTick: 30 },
		});
		expect(parse({ ...timing, SUBREQUEST_LIMIT: "10000000" }).ok).toBe(true);
		expect(
			parse({ QUOTE_WINDOW_SECONDS: "1", POLL_INTERVAL_MS: "1000", SUBREQUEST_LIMIT: "9" }),
		).toMatchObject({ ok: true, config: { probesPlannedPerTick: 1 } });
		for (const bad of ["1", "10000001", "fifty", ""]) {
			expect(parse({ SUBREQUEST_LIMIT: bad }), bad).toMatchObject({
				ok: false,
				errors: [expect.stringMatching(/^SUBREQUEST_LIMIT: /)],
			});
		}
	});

	it("publishes every PUBLISH_EVERY_TICKS ticks, 1 to 60, and every tick when unset", () => {
		expect(parse({ PROBE_CRON: "*/2 * * * *", PUBLISH_EVERY_TICKS: undefined })).toMatchObject({
			ok: true,
			config: { tickIntervalMinutes: 2, publishEveryTicks: 1, publishIntervalMinutes: 2 },
		});
		for (const [cron, every, tick, publish] of [
			["*/2 * * * *", "5", 2, 10],
			["*/5 * * * *", "1", 5, 5],
			["*/1 * * * *", "60", 1, 60],
			["0 * * * *", "3", 60, 180],
		] as const) {
			expect(
				parse({ PROBE_CRON: cron, PUBLISH_EVERY_TICKS: every }),
				`${cron} ${every}`,
			).toMatchObject({
				ok: true,
				config: {
					tickIntervalMinutes: tick,
					publishEveryTicks: Number(every),
					publishIntervalMinutes: publish,
				},
			});
		}
		for (const bad of ["0", "61", "2.5", "-1", "five", ""]) {
			expect(parse({ PUBLISH_EVERY_TICKS: bad }), bad).toMatchObject({
				ok: false,
				errors: [expect.stringMatching(/^PUBLISH_EVERY_TICKS: /)],
			});
		}
	});

	it("refuses a quote window and poll interval that leave no probe in the budget", () => {
		const result = parse({ QUOTE_WINDOW_SECONDS: "60", POLL_INTERVAL_MS: "100" });
		expect(result).toMatchObject({ ok: false, errors: [expect.any(String)] });
		expect(result.ok || result.errors[0]).toMatch(
			/^SUBREQUEST_LIMIT: .*QUOTE_WINDOW_SECONDS.*POLL_INTERVAL_MS/,
		);
	});

	it("requires both crons as five fields joined by single spaces", () => {
		for (const name of ["PROBE_CRON", "CANARY_CRON"]) {
			const deployed = String(env[name as keyof typeof env]);
			for (const bad of [
				"",
				undefined,
				`${deployed} `,
				` ${deployed}`,
				deployed.replace(" ", "  "),
				deployed.replace(" ", "\t"),
				"nonsense",
				"* * * *",
				"0 * * * * *",
			]) {
				expect(parse({ [name]: bad }), JSON.stringify(bad)).toMatchObject({
					ok: false,
					errors: [expect.stringMatching(new RegExp(`^${name}: `))],
				});
			}
		}
		expect(parse({ PROBE_CRON: "*/10 * * * *", CANARY_CRON: "1-59/10 * * * *" })).toMatchObject({
			ok: true,
			config: { probeCron: "*/10 * * * *", canaryCron: "1-59/10 * * * *" },
		});
	});

	it("refuses one expression for both crons", () => {
		expect(parse({ PROBE_CRON: "*/5 * * * *", CANARY_CRON: "*/5 * * * *" })).toMatchObject({
			ok: false,
			errors: [expect.stringMatching(/^CANARY_CRON: /)],
		});
	});

	it("names the variable and the allowed values for a bad choice, never the value", () => {
		const secret = "https://hooks.example.test/services/T0/B0/secret-token";
		for (const [name, allowed] of [
			["ALERT_WEBHOOK_FORMAT", "slack or json"],
			["ALERT_MIN_SEVERITY", "critical or warning"],
		] as const) {
			const result = parse({ [name]: secret });
			expect(result).toStrictEqual({ ok: false, errors: [`${name}: must be ${allowed}`] });
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
