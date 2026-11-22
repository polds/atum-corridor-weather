import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RawExchange } from "../../src/domain/types";
import { createGatewayClient } from "../../src/gateway/client";
import { createStore } from "../../src/store/store";
import { runTick, type TickDeps } from "../../src/worker/tick";
import { clearTables } from "../support/db";
import { FakeClock, type Handler, jsonResponse, scriptedFetch } from "../support/fake-gateway";
import { fixtures, type ProbeFixture, QUOTED_SETTLER } from "../support/fixtures";
import { ONE_TARGET, postedRequestIds, testConfig, tickHarness } from "../support/tick";

const SCHEDULED = Date.parse("2026-11-22T10:35:00.000Z");
const quotedEverywhere = () => fixtures.quoted;

async function count(table: string): Promise<number> {
	const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first("n");
	return typeof row === "number" ? row : -1;
}

async function tableCounts(): Promise<Record<string, number>> {
	const tables = ["ticks", "corridors", "probes", "probe_declines", "probe_raw", "snapshots"];
	return Object.fromEntries(
		await Promise.all(tables.map(async (table) => [table, await count(table)])),
	);
}

beforeEach(clearTables);

describe("runTick", () => {
	it("discovers corridors, probes a batch, stores every probe and publishes a snapshot", async () => {
		const config = testConfig({ PROBES_PER_TICK: "4", AMOUNT_TIERS: '{"small":"1"}' });
		const { deps, store, requests } = tickHarness({
			startMs: SCHEDULED + 1000,
			config,
			scenario: quotedEverywhere,
		});
		const tick = await runTick(deps, SCHEDULED);

		expect(tick.slot).toStrictEqual({
			network: "testnet",
			index: 5_984_479,
			start: "2026-11-22T10:35:00.000Z",
		});
		expect(tick.corridors).toHaveLength(552);
		expect(tick.planned).toBe(4);
		expect(tick.aborted).toBeNull();
		expect(tick.probes.map((probe) => probe.outcome.kind)).toStrictEqual([
			"quoted",
			"quoted",
			"quoted",
			"quoted",
		]);
		expect(postedRequestIds(requests)).toStrictEqual(tick.probes.map((probe) => probe.id));
		for (const id of postedRequestIds(requests)) {
			expect(id).toMatch(/^cw1\.testnet\.20261122T1035Z\.[0-9a-f]{12}\.small$/);
		}

		expect(await tableCounts()).toStrictEqual({
			ticks: 1,
			corridors: 552,
			probes: 4,
			probe_declines: 0,
			probe_raw: 4,
			snapshots: 1,
		});
		const raw = await env.DB.prepare("SELECT raw_json FROM probe_raw WHERE probe_id = ?1")
			.bind(tick.probes[0]?.id ?? "")
			.first("raw_json");
		const stored: unknown = typeof raw === "string" ? JSON.parse(raw) : null;
		expect(stored).toMatchObject({ requestBody: { request_id: tick.probes[0]?.id } });
		expect(stored).toHaveProperty("exchanges", tick.probes[0]?.raw);
		expect(String(raw)).toContain(QUOTED_SETTLER);

		const snapshot = await store.readSnapshot("testnet");
		expect(snapshot?.corridors).toHaveLength(552);
		expect(snapshot?.corridors.filter((corridor) => corridor.condition === "fair")).toHaveLength(4);
		expect(snapshot?.lastTick).toMatchObject({
			planned: 4,
			completed: 4,
			gatewayErrors: 0,
			aborted: null,
		});
		expect(snapshot?.cadence).toStrictEqual({ probesPerTick: 4, sweepHours: 11.5 });
		expect(JSON.stringify(snapshot).toLowerCase()).not.toContain(QUOTED_SETTLER);
	});

	it("leaves the same rows and sends the same request ids when the same slot runs twice", async () => {
		const config = testConfig({
			PROBES_PER_TICK: "3",
			AMOUNT_TIERS: '{"small":"1","large":"250"}',
		});
		const first = tickHarness({ startMs: SCHEDULED + 1000, config, scenario: quotedEverywhere });
		await runTick(first.deps, SCHEDULED);
		const countsAfterFirst = await tableCounts();
		const probesAfterFirst = await env.DB.prepare(
			"SELECT id, corridor_id, tier, outcome, quote_count FROM probes ORDER BY id",
		).all();

		const second = tickHarness({ startMs: SCHEDULED + 90_000, config, scenario: quotedEverywhere });
		const retried = await runTick(second.deps, SCHEDULED + 60_000);

		expect(postedRequestIds(second.requests)).toStrictEqual(postedRequestIds(first.requests));
		expect(await tableCounts()).toStrictEqual(countsAfterFirst);
		const probesAfterSecond = await env.DB.prepare(
			"SELECT id, corridor_id, tier, outcome, quote_count FROM probes ORDER BY id",
		).all();
		expect(probesAfterSecond.results).toStrictEqual(probesAfterFirst.results);
		expect(retried.probes.map((probe) => probe.id)).toHaveLength(3);
	});

	it("records a failed discovery as an aborted tick and still publishes", async () => {
		const config = testConfig(ONE_TARGET);
		const ok = tickHarness({ startMs: SCHEDULED + 1000, config, scenario: quotedEverywhere });
		await runTick(ok.deps, SCHEDULED);

		const down = tickHarness({
			startMs: SCHEDULED + 301_000,
			config,
			scenario: quotedEverywhere,
			defaults: () => jsonResponse(503, { code: "SERVICE_UNAVAILABLE", message: "try later" }),
		});
		const tick = await runTick(down.deps, SCHEDULED + 300_000);
		expect(tick.aborted).toStrictEqual({
			reason: "defaults_unavailable",
			message: "HTTP 503 SERVICE_UNAVAILABLE: try later",
		});
		expect(tick.corridors).toStrictEqual([]);
		expect(postedRequestIds(down.requests)).toStrictEqual([]);

		const snapshot = await down.store.readSnapshot("testnet");
		expect(snapshot?.lastTick).toMatchObject({
			slotStart: "2026-11-22T10:40:00.000Z",
			aborted: "defaults_unavailable",
		});
		expect(snapshot?.corridors.map((corridor) => corridor.condition)).toStrictEqual(["fair"]);
		expect(snapshot?.alerts.map((alert) => alert.kind)).toStrictEqual(["gateway_errors"]);
	});

	it("stops the tick at the first rate-limited probe", async () => {
		let created = 0;
		const config = testConfig({ PROBES_PER_TICK: "4", AMOUNT_TIERS: '{"small":"1"}' });
		const { deps, requests } = tickHarness({
			startMs: SCHEDULED + 1000,
			config,
			scenario: () => {
				created += 1;
				return created === 2
					? jsonResponse(429, { code: "RATE_LIMIT_EXCEEDED", message: "Too many requests" })
					: fixtures.quoted;
			},
		});
		const tick = await runTick(deps, SCHEDULED);
		expect(tick.probes.map((probe) => probe.outcome.kind)).toStrictEqual([
			"quoted",
			"gateway_error",
		]);
		expect(tick.aborted).toMatchObject({ reason: "rate_limited" });
		expect(tick.planned).toBe(4);
		expect(postedRequestIds(requests)).toHaveLength(2);
		expect(await count("probes")).toBe(2);
	});

	it("sends nothing when probing is disabled", async () => {
		const { deps, requests, store } = tickHarness({
			startMs: SCHEDULED + 1000,
			config: testConfig({ PROBE_ENABLED: "false" }),
			scenario: quotedEverywhere,
		});
		const tick = await runTick(deps, SCHEDULED);
		expect(requests).toHaveLength(0);
		expect(tick.aborted).toStrictEqual({ reason: "disabled", message: "PROBE_ENABLED is false" });
		expect((await store.readSnapshot("testnet"))?.alerts).toStrictEqual([]);
	});

	it("drops raw exchanges older than the retention window", async () => {
		await env.DB.prepare(
			"INSERT INTO probe_raw (probe_id, created_at, raw_json) VALUES ('old', '2026-11-01T00:00:00.000Z', '{}')",
		).run();
		const { deps } = tickHarness({
			startMs: SCHEDULED + 1000,
			config: testConfig({ ...ONE_TARGET, RAW_RETENTION_DAYS: "14" }),
			scenario: quotedEverywhere,
		});
		await runTick(deps, SCHEDULED);
		const ids = await env.DB.prepare("SELECT probe_id FROM probe_raw").all();
		expect(ids.results).toStrictEqual([
			{ probe_id: "cw1.testnet.20261122T1035Z.7ae33acb9dd6.small" },
		]);
	});

	it("stores each decline reason of a declined probe", async () => {
		const { deps } = tickHarness({
			startMs: SCHEDULED + 1000,
			config: testConfig(ONE_TARGET),
			scenario: () => fixtures.declinedLiquidity,
		});
		await runTick(deps, SCHEDULED);
		const declines = await env.DB.prepare(
			"SELECT reason, retry_classification, count FROM probe_declines",
		).all();
		expect(declines.results).toStrictEqual([
			{ reason: "INSUFFICIENT_LIQUIDITY", retry_classification: "RETRY_AFTER_DELAY", count: 1 },
		]);
	});
});

describe("oversized gateway responses", () => {
	/** The quoted fixture with an unknown field of `bytes` characters on every poll answer. */
	function padded(bytes: number, polls: number): ProbeFixture {
		const pad = "x".repeat(bytes);
		const [create, ...answers] = fixtures.quoted.events;
		const last = answers.at(-1);
		if (create === undefined || last === undefined) throw new Error("fixture has no events");
		const collecting = answers.slice(0, -1);
		return {
			...fixtures.quoted,
			events: [
				create,
				...Array.from({ length: polls - 1 }, (_, index) => {
					const event = collecting[Math.min(index, collecting.length - 1)] ?? last;
					return { ...event, json: { ...(event.json as object), pad } };
				}),
				{ ...last, json: { ...(last.json as object), pad } },
			],
		};
	}

	async function storedProbe(): Promise<Record<string, unknown> | null> {
		return env.DB.prepare("SELECT outcome, error_message FROM probes").first();
	}

	it("stores the tick when every poll answer is 400 KB", async () => {
		const { deps, store } = tickHarness({
			startMs: SCHEDULED + 1000,
			config: testConfig(ONE_TARGET),
			scenario: () => padded(400_000, 6),
		});
		await runTick(deps, SCHEDULED);
		expect(await count("ticks")).toBe(1);
		expect(await storedProbe()).toMatchObject({
			outcome: "gateway_error",
			error_message: expect.stringContaining("response too large"),
		});
		expect((await store.readSnapshot("testnet"))?.lastTick).toMatchObject({ completed: 1 });
	});

	it("stores the tick when the create call answers a 2.2 MB 502", async () => {
		const { deps, store } = tickHarness({
			startMs: SCHEDULED + 1000,
			config: testConfig(ONE_TARGET),
			scenario: () => new Response(`<html>${"x".repeat(2_200_000)}`, { status: 502 }),
		});
		await runTick(deps, SCHEDULED);
		expect(await count("ticks")).toBe(1);
		expect(await storedProbe()).toMatchObject({
			outcome: "gateway_error",
			error_message: expect.stringContaining("response too large"),
		});
		const raw = await env.DB.prepare("SELECT length(raw_json) AS n FROM probe_raw").first("n");
		expect(raw).toBeLessThan(10_000);
		expect((await store.readSnapshot("testnet"))?.lastTick).toMatchObject({ completed: 1 });
	});

	it("cuts every response body when the first and last exchanges alone exceed the raw budget", async () => {
		// Each control character takes six bytes once JSON-encoded.
		const body = "\u0001".repeat(250_000);
		const { deps } = tickHarness({
			startMs: SCHEDULED + 1000,
			config: testConfig(ONE_TARGET),
			scenario: () => new Response(body, { status: 502 }),
		});
		await runTick(deps, SCHEDULED);
		const raw = await env.DB.prepare("SELECT raw_json FROM probe_raw").first("raw_json");
		const { exchanges } = JSON.parse(String(raw)) as { exchanges: RawExchange[] };
		expect(exchanges.map((exchange) => exchange.responseBody)).toStrictEqual([
			{ truncated: true, bytes: JSON.stringify(body).length },
		]);
		expect(await storedProbe()).toMatchObject({ outcome: "gateway_error" });
	});

	it("cuts the middle response bodies when a probe's exchanges exceed the raw budget", async () => {
		const { deps, store } = tickHarness({
			startMs: SCHEDULED + 1000,
			config: testConfig(ONE_TARGET),
			scenario: () => padded(240_000, 10),
		});
		const tick = await runTick(deps, SCHEDULED);
		const [probe] = tick.probes;
		expect(probe?.outcome.kind).toBe("quoted");
		expect(probe?.raw).toHaveLength(11);
		expect(await storedProbe()).toMatchObject({ outcome: "quoted" });
		const raw = await env.DB.prepare("SELECT raw_json FROM probe_raw").first("raw_json");
		expect(String(raw).length).toBeLessThanOrEqual(1024 * 1024);
		const { exchanges } = JSON.parse(String(raw)) as { exchanges: RawExchange[] };
		expect(exchanges.map((exchange) => exchange.path)).toStrictEqual(
			probe?.raw.map((exchange) => exchange.path),
		);
		expect(exchanges[0]).toStrictEqual(probe?.raw[0]);
		expect(exchanges.at(-1)).toStrictEqual(probe?.raw.at(-1));
		expect(exchanges[1]?.responseBody).toStrictEqual({
			truncated: true,
			bytes: JSON.stringify(probe?.raw[1]?.responseBody).length,
		});
		expect((await store.readSnapshot("testnet"))?.corridors[0]?.condition).toBe("fair");
	});
});

describe("a retried cron run of the same slot", () => {
	/**
	 * Like the real gateway: the first POST of a request_id opens a batch that
	 * plays the quoted fixture; a repeated POST answers 200 with
	 * `idempotent_replay: true`, and polls of it return the batch's final state.
	 */
	function replayingGateway(clock: FakeClock): Handler {
		const final = fixtures.quoted.events.at(-1)?.json as object;
		const batches = new Map<string, { sentAt: number; next: number }>();
		return (request) => {
			if (request.url.pathname === "/v1/defaults") {
				return jsonResponse(200, fixtures.testnetDefaults);
			}
			if (request.method === "POST") {
				const id = `qr_${(request.body as { request_id: string }).request_id}`;
				if (batches.has(id)) {
					batches.set(id, { sentAt: clock.ms, next: Number.POSITIVE_INFINITY });
					return jsonResponse(200, {
						quote_request_id: id,
						status: "ready",
						idempotent_replay: true,
					});
				}
				batches.set(id, { sentAt: clock.ms, next: 1 });
				return jsonResponse(202, { quote_request_id: id, status: "collecting" });
			}
			const id = decodeURIComponent(request.url.pathname.split("/").at(-1) ?? "");
			const batch = batches.get(id);
			if (batch === undefined) return jsonResponse(404, { code: "NOT_FOUND", message: "no batch" });
			const event = fixtures.quoted.events[batch.next];
			if (event === undefined) return jsonResponse(200, { ...final, quote_request_id: id });
			batch.next += 1;
			clock.advanceTo(batch.sentAt + event.t);
			return jsonResponse(event.status, { ...(event.json as object), quote_request_id: id });
		};
	}

	function harness(clock: FakeClock): TickDeps {
		const config = testConfig(ONE_TARGET);
		return {
			config,
			gateway: createGatewayClient({
				baseUrl: config.gatewayUrl,
				userAgent: "corridor-weather/test",
				fetch: scriptedFetch(replayingGateway(clock)).fetch,
				now: clock.now,
				timeoutMs: 1000,
			}),
			store: createStore(env.DB),
			now: clock.now,
			sleep: clock.sleep,
		};
	}

	async function storedRows(): Promise<Record<string, unknown[]>> {
		const tables = ["ticks", "probes", "probe_declines", "probe_raw"];
		return Object.fromEntries(
			await Promise.all(
				tables.map(async (table) => [
					table,
					(await env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()).results,
				]),
			),
		);
	}

	it("leaves every stored row byte-identical", async () => {
		const clock = new FakeClock(SCHEDULED + 1000);
		const deps = harness(clock);
		await runTick(deps, SCHEDULED);
		const first = await storedRows();
		expect(first.probes).toMatchObject([
			{ idempotent_replay: 0, first_quote_ms: 594, min_price_hold_ms: expect.any(Number) },
		]);

		clock.advanceTo(SCHEDULED + 120_000);
		const retried = await runTick(deps, SCHEDULED + 60_000);
		expect(retried.probes.map((probe) => probe.idempotentReplay)).toStrictEqual([true]);
		expect(await storedRows()).toStrictEqual(first);
	});

	it("stores a replay with no earlier row without timings or a price hold", async () => {
		const clock = new FakeClock(SCHEDULED + 1000);
		const deps = harness(clock);
		await runTick(deps, SCHEDULED);
		// The first run reached the gateway and died before it stored anything.
		await clearTables();

		clock.advanceTo(SCHEDULED + 120_000);
		await runTick(deps, SCHEDULED + 60_000);
		const probe = await env.DB.prepare(
			"SELECT idempotent_replay, outcome, first_quote_ms, ready_ms, min_price_hold_ms FROM probes",
		).first();
		expect(probe).toStrictEqual({
			idempotent_replay: 1,
			outcome: "quoted",
			first_quote_ms: null,
			ready_ms: null,
			min_price_hold_ms: null,
		});
		const snapshot = await deps.store.readSnapshot("testnet");
		for (const reading of snapshot?.corridors.flatMap((corridor) => corridor.tiers) ?? []) {
			expect(reading.minPriceHoldMs ?? 0).toBeGreaterThanOrEqual(0);
		}
	});
});

describe("the snapshot follows the configured tiers", () => {
	it("drops a tier removed from AMOUNT_TIERS, with its quotes_lost alert", async () => {
		const both = testConfig({
			...ONE_TARGET,
			AMOUNT_TIERS: '{"small":"1","large":"250"}',
			PROBES_PER_TICK: "2",
		});
		await runTick(
			tickHarness({ startMs: SCHEDULED + 1000, config: both, scenario: quotedEverywhere }).deps,
			SCHEDULED,
		);
		const lost = tickHarness({
			startMs: SCHEDULED + 301_000,
			config: both,
			scenario: (id) => (id.endsWith(".large") ? fixtures.declinedLiquidity : fixtures.quoted),
		});
		await runTick(lost.deps, SCHEDULED + 300_000);
		expect(
			(await lost.store.readSnapshot("testnet"))?.alerts.map((alert) => alert.kind),
		).toStrictEqual(["quotes_lost"]);

		const smallOnly = testConfig({ ...ONE_TARGET, PROBES_PER_TICK: "2" });
		const after = tickHarness({
			startMs: SCHEDULED + 601_000,
			config: smallOnly,
			scenario: quotedEverywhere,
		});
		await runTick(after.deps, SCHEDULED + 600_000);
		const snapshot = await after.store.readSnapshot("testnet");
		expect(snapshot?.corridors[0]?.tiers.map((reading) => reading.tier)).toStrictEqual(["small"]);
		expect(snapshot?.alerts).toStrictEqual([]);
	});
});

describe("a listing that yields no corridor", () => {
	it.each([
		["an empty object", {}],
		["an error object", { error: "maintenance" }],
	])("aborts the tick as defaults_unavailable for %s and keeps the corridors", async (_, body) => {
		const config = testConfig(ONE_TARGET);
		await runTick(
			tickHarness({ startMs: SCHEDULED + 1000, config, scenario: quotedEverywhere }).deps,
			SCHEDULED,
		);
		const empty = tickHarness({
			startMs: SCHEDULED + 301_000,
			config,
			scenario: quotedEverywhere,
			defaults: () => jsonResponse(200, body),
		});
		const tick = await runTick(empty.deps, SCHEDULED + 300_000);
		expect(tick.aborted).toMatchObject({
			reason: "defaults_unavailable",
			message: expect.stringContaining("no usable chain"),
		});
		expect(postedRequestIds(empty.requests)).toStrictEqual([]);
		const snapshot = await empty.store.readSnapshot("testnet");
		expect(snapshot?.corridors.map((corridor) => corridor.id)).toStrictEqual([
			"eip155:421614/erc20:0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d>eip155:84532/erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e",
		]);
		expect(snapshot?.alerts.map((alert) => alert.kind)).toStrictEqual(["gateway_errors"]);
	});

	it("records a CORRIDOR_FILTER that matches nothing as an empty tick with a warning", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { deps, store, requests } = tickHarness({
			startMs: SCHEDULED + 1000,
			config: testConfig({ ...ONE_TARGET, CORRIDOR_FILTER: "^nothing$" }),
			scenario: quotedEverywhere,
		});
		const tick = await runTick(deps, SCHEDULED);
		expect(tick).toMatchObject({ planned: 0, aborted: null });
		expect(postedRequestIds(requests)).toStrictEqual([]);
		expect(await count("ticks")).toBe(1);
		expect((await store.readSnapshot("testnet"))?.alerts).toStrictEqual([]);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "corridor_filter_matched_nothing" }),
		);
		warn.mockRestore();
	});
});

describe("the gateway_errors alert", () => {
	it("starts at the first failing tick of an outage longer than 50 ticks", async () => {
		const config = testConfig(ONE_TARGET);
		await runTick(
			tickHarness({ startMs: SCHEDULED - 299_000, config, scenario: quotedEverywhere }).deps,
			SCHEDULED - 300_000,
		);
		let store = createStore(env.DB);
		for (let tick = 0; tick < 60; tick += 1) {
			const down = tickHarness({
				startMs: SCHEDULED + tick * 300_000 + 1000,
				config,
				scenario: quotedEverywhere,
				defaults: () => jsonResponse(503, { code: "SERVICE_UNAVAILABLE", message: "down" }),
			});
			await runTick(down.deps, SCHEDULED + tick * 300_000);
			store = down.store;
		}
		const alert = (await store.readSnapshot("testnet"))?.alerts.find(
			(candidate) => candidate.kind === "gateway_errors",
		);
		expect(alert?.since).toBe("2026-11-22T10:35:00.000Z");
	});
});

describe("tier amounts a token cannot represent", () => {
	it("counts the targets dropped for too many fractional digits", async () => {
		const { deps } = tickHarness({
			startMs: SCHEDULED + 1000,
			config: testConfig({ ...ONE_TARGET, AMOUNT_TIERS: '{"small":"1","large":"0.0000001"}' }),
			scenario: quotedEverywhere,
		});
		const tick = await runTick(deps, SCHEDULED);
		expect(tick).toMatchObject({ planned: 1, unrepresentable: 1 });
	});
});
