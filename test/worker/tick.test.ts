import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUBREQUEST_RESERVE } from "../../src/domain/schedule";
import type { RawExchange } from "../../src/domain/types";
import { createGatewayClient } from "../../src/gateway/client";
import { createStore } from "../../src/store/store";
import type { Config } from "../../src/worker/config";
import { readHealth } from "../../src/worker/health";
import { runTick, type TickDeps } from "../../src/worker/tick";
import { clearTables } from "../support/db";
import {
	FakeClock,
	type Handler,
	jsonResponse,
	SUBREQUEST_REFUSAL,
	scriptedFetch,
} from "../support/fake-gateway";
import { declinedWith, fixtures, type ProbeFixture, QUOTED_SETTLER } from "../support/fixtures";
import { readRawExchanges } from "../support/raw";
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
		expect(await readRawExchanges(tick.probes[0]?.id ?? "")).toStrictEqual(
			tick.probes[0]?.raw.map(({ method, path, status, responseBody }) => ({
				method,
				path,
				status,
				responseBody,
			})),
		);
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

	it("records a gateway error for a hostile quote_request_id and stores the rest of the tick", async () => {
		const { deps } = tickHarness({
			startMs: SCHEDULED + 1000,
			config: testConfig({ ...ONE_TARGET, AMOUNT_TIERS: '{"small":"1","typical":"25"}' }),
			scenario: (requestId) =>
				requestId.endsWith(".small")
					? new Response('{"quote_request_id":"\\ud800","status":"collecting"}', { status: 202 })
					: fixtures.quoted,
		});
		await runTick(deps, SCHEDULED);
		const probes = await env.DB.prepare("SELECT tier, outcome FROM probes ORDER BY tier").all();
		expect(probes.results).toStrictEqual([
			{ tier: "small", outcome: "gateway_error" },
			{ tier: "typical", outcome: "quoted" },
		]);
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
	/**
	 * The quoted fixture with an unknown field of `bytes` characters on every poll
	 * answer. Each answer's field differs, so no two bodies are the same.
	 */
	function padded(bytes: number, polls: number): ProbeFixture {
		const pad = (poll: number) => `${poll}${"x".repeat(bytes)}`;
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
					return { ...event, json: { ...(event.json as object), pad: pad(index) } };
				}),
				{ ...last, json: { ...(last.json as object), pad: pad(polls) } },
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

	it("keeps publishing snapshots after probes stored decline reasons of 240 KB", async () => {
		const reason = "R".repeat(240_000);
		const config = testConfig({
			CORRIDOR_FILTER: "^eip155:\\d+/USDC>eip155:\\d+/USDC$",
			AMOUNT_TIERS: '{"small":"1","typical":"25","large":"100"}',
			PROBES_PER_TICK: "15",
			// 15 probes of 7 requests need more than the Workers Free 50.
			SUBREQUEST_LIMIT: "10000",
		});
		const hostile = tickHarness({
			startMs: SCHEDULED + 1000,
			config,
			scenario: () => declinedWith([{ reason, count: 1, retry_classification: "x".repeat(1000) }]),
		});
		const first = await runTick(hostile.deps, SCHEDULED);
		expect(first.probes.map((probe) => probe.outcome.kind)).toStrictEqual(
			Array(15).fill("declined"),
		);
		const next = tickHarness({ startMs: SCHEDULED + 301_000, config, scenario: quotedEverywhere });
		await runTick(next.deps, SCHEDULED + 300_000);
		const snapshot = await next.store.readSnapshot("testnet");
		expect(snapshot?.lastTick?.slotStart).toBe("2026-11-22T10:40:00.000Z");
		expect(snapshot?.corridors.flatMap((corridor) => corridor.tiers)).toContainEqual(
			expect.objectContaining({
				outcome: "declined",
				declines: [{ reason: "OTHER", retryClassification: null, count: 1 }],
			}),
		);
	});

	for (const depth of [10_000, 100_000]) {
		it(`stores the tick when every poll answer nests arrays ${depth} deep in an unknown field`, async () => {
			const nested = `${"[".repeat(depth)}${"]".repeat(depth)}`;
			const { deps } = tickHarness({
				startMs: SCHEDULED + 1000,
				config: testConfig(ONE_TARGET),
				scenario: quotedEverywhere,
				wrap: (handler) => async (request) => {
					const response = await handler(request);
					if (request.method === "POST" || request.url.pathname === "/v1/defaults") return response;
					const text = await response.text();
					return new Response(`${text.slice(0, -1)},"x":${nested}}`, { status: response.status });
				},
			});
			await runTick(deps, SCHEDULED);
			expect(await count("ticks")).toBe(1);
			expect(await storedProbe()).toMatchObject({ outcome: "quoted" });
			expect(await count("probe_raw")).toBe(1);
		});
	}

	it("cuts every response body when the first and last exchanges alone exceed the raw budget", async () => {
		// Each control character takes six bytes once JSON-encoded, one as body text.
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
			{ truncated: true, bytes: body.length },
		]);
		expect(await storedProbe()).toMatchObject({ outcome: "gateway_error" });
	});

	it("cuts the middle response bodies when a probe's exchanges exceed the raw budget", async () => {
		const { deps, store } = tickHarness({
			startMs: SCHEDULED + 1000,
			config: testConfig(ONE_TARGET),
			scenario: () => padded(240_000, 6),
		});
		const tick = await runTick(deps, SCHEDULED);
		const [probe] = tick.probes;
		expect(probe?.outcome.kind).toBe("quoted");
		expect(probe?.raw).toHaveLength(7);
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
			bytes: probe?.raw[1]?.responseBody?.length,
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

describe("quotes_lost follows the configured tiers", () => {
	const both = testConfig({
		...ONE_TARGET,
		AMOUNT_TIERS: '{"small":"1","large":"250"}',
		PROBES_PER_TICK: "2",
	});
	const smallOnly = testConfig({ ...ONE_TARGET, PROBES_PER_TICK: "2" });
	const DAY_MS = 24 * 60 * 60_000;
	type Outcome = "quoted" | "declined";

	/** One tick `offsetMs` after SCHEDULED. Returns the kinds of the snapshot's alerts. */
	async function tickWith(
		offsetMs: number,
		config: typeof both,
		small: Outcome,
		large: Outcome = small,
	): Promise<string[]> {
		const fixture = (outcome: Outcome) =>
			outcome === "quoted" ? fixtures.quoted : fixtures.declinedLiquidity;
		const run = tickHarness({
			startMs: SCHEDULED + offsetMs + 1000,
			config,
			scenario: (id) => fixture(id.endsWith(".large") ? large : small),
		});
		await runTick(run.deps, SCHEDULED + offsetMs);
		return ((await run.store.readSnapshot("testnet"))?.alerts ?? []).map((alert) => alert.kind);
	}

	it("raises nothing while one tier still quotes", async () => {
		expect(await tickWith(0, both, "quoted")).toStrictEqual([]);
		expect(await tickWith(300_000, both, "quoted", "declined")).toStrictEqual([]);
		expect(await tickWith(600_000, both, "declined", "quoted")).toStrictEqual([]);
	});

	it("raises nothing once the last quote is older than 7 days", async () => {
		expect(await tickWith(0, both, "quoted")).toStrictEqual([]);
		expect(await tickWith(300_000, both, "declined")).toStrictEqual(["quotes_lost"]);
		expect(await tickWith(7 * DAY_MS - 300_000, both, "declined")).toStrictEqual(["quotes_lost"]);
		expect(await tickWith(7 * DAY_MS + 300_000, both, "declined")).toStrictEqual([]);
	});

	it("ignores a tier removed from AMOUNT_TIERS that still quotes", async () => {
		await tickWith(0, both, "quoted");
		expect(await tickWith(300_000, both, "declined", "quoted")).toStrictEqual([]);
		expect(await tickWith(600_000, smallOnly, "declined")).toStrictEqual(["quotes_lost"]);
	});

	it("ignores the last quote of a tier removed from AMOUNT_TIERS", async () => {
		await tickWith(0, both, "declined", "quoted");
		expect(await tickWith(300_000, both, "declined")).toStrictEqual(["quotes_lost"]);
		const snapshot = await createStore(env.DB).readSnapshot("testnet");
		expect(snapshot?.corridors[0]?.tiers.map((reading) => reading.tier)).toStrictEqual([
			"small",
			"large",
		]);
		expect(await tickWith(600_000, smallOnly, "declined")).toStrictEqual([]);
		const after = await createStore(env.DB).readSnapshot("testnet");
		expect(after?.corridors[0]?.tiers.map((reading) => reading.tier)).toStrictEqual(["small"]);
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

/** The quoted fixture with every answer `collecting`, so a probe polls until its schedule ends. */
const collectingForever: ProbeFixture = {
	...fixtures.quoted,
	events: fixtures.quoted.events.map((event) => ({
		...event,
		json: { ...(event.json as object), status: "collecting" },
	})),
};

describe("the subrequest budget", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("plans 6 probes on the free-plan default and keeps the reserve out of 50 requests", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		// SUBREQUEST_LIMIT 50, a 3 s window polled every 500 ms, and the 30 probes testConfig pins.
		const config = testConfig();
		expect(config).toMatchObject({
			subrequestLimit: 50,
			quoteWindowSeconds: 3,
			pollIntervalMs: 500,
			probesPerTick: 30,
		});
		const { deps, requests, store } = tickHarness({
			startMs: SCHEDULED + 1000,
			config,
			scenario: () => collectingForever,
		});
		const tick = await runTick(deps, SCHEDULED);

		expect(tick.planned).toBe(6);
		expect(tick.probes.map((probe) => probe.outcome.kind)).toStrictEqual(
			Array(6).fill("incomplete"),
		);
		// Every probe polls to the end here, so this is the most a tick can send.
		expect(requests.length).toBe(1 + 6 * 7);
		expect(requests.length).toBeLessThanOrEqual(50 - SUBREQUEST_RESERVE);
		const capped = warn.mock.calls.filter(
			(call: unknown[]) => (call[0] as { event?: unknown }).event === "probes_capped",
		);
		expect(capped).toStrictEqual([
			[
				{
					event: "probes_capped",
					configured: 30,
					planned: 6,
					subrequestLimit: 50,
					requestsPerProbe: 7,
				},
			],
		]);
		expect((await store.readSnapshot("testnet"))?.cadence).toStrictEqual({
			probesPerTick: 6,
			sweepHours: 23,
		});
	});

	it("plans the configured 30 probes on a paid limit and logs no cap", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const config = testConfig({ SUBREQUEST_LIMIT: "10000" });
		expect(config.probesPlannedPerTick).toBe(30);
		const { deps, store } = tickHarness({
			startMs: SCHEDULED + 1000,
			config,
			scenario: quotedEverywhere,
		});
		const tick = await runTick(deps, SCHEDULED);
		expect(tick.planned).toBe(30);
		expect(tick.probes).toHaveLength(30);
		expect(warn).not.toHaveBeenCalledWith(expect.objectContaining({ event: "probes_capped" }));
		expect((await store.readSnapshot("testnet"))?.cadence).toMatchObject({ probesPerTick: 30 });
	});

	it("covers every target exactly once per sweep at the planned size", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const config = testConfig({
			CORRIDOR_FILTER: "^eip155:421614/USDC>",
			AMOUNT_TIERS: '{"small":"1","typical":"25"}',
			PROBES_PER_TICK: "30",
			SUBREQUEST_LIMIT: "50",
		});
		const probed: string[] = [];
		let targets = 0;
		for (let index = 0; probed.length === 0 || probed.length < targets; index += 1) {
			const slotMs = SCHEDULED + index * 300_000;
			const run = tickHarness({ startMs: slotMs + 1000, config, scenario: quotedEverywhere });
			const tick = await runTick(run.deps, slotMs);
			targets = tick.corridors.length * 2;
			expect(tick.planned).toBe(6);
			probed.push(
				...tick.probes.map((probe) => `${probe.target.corridor.id} ${probe.target.tier}`),
			);
		}
		expect(targets).toBe(46);
		const sweep = probed.slice(0, targets);
		expect(new Set(sweep).size).toBe(targets);
	});

	it("stops as subrequest_limit and stores no row for the probe that hit it", async () => {
		let sent = 0;
		const { deps, store } = tickHarness({
			startMs: SCHEDULED + 1000,
			config: testConfig({
				PROBES_PER_TICK: "4",
				AMOUNT_TIERS: '{"small":"1"}',
				SUBREQUEST_LIMIT: "10000",
			}),
			scenario: quotedEverywhere,
			// Like the platform: past a number of subrequests, every later fetch throws.
			wrap: (handler) => (request) => {
				sent += 1;
				if (sent > 1 + 2 * 7 + 3) throw new Error(SUBREQUEST_REFUSAL);
				return handler(request);
			},
		});
		const tick = await runTick(deps, SCHEDULED);
		expect(tick.aborted).toMatchObject({
			reason: "subrequest_limit",
			message: expect.stringContaining(SUBREQUEST_REFUSAL),
		});
		expect(tick.planned).toBe(4);
		expect(tick.probes.map((probe) => probe.outcome.kind)).toStrictEqual(["quoted", "quoted"]);
		expect(await count("probes")).toBe(2);
		expect(await count("probe_raw")).toBe(2);
		const snapshot = await store.readSnapshot("testnet");
		expect(snapshot?.lastTick).toMatchObject({
			completed: 2,
			gatewayErrors: 0,
			aborted: "subrequest_limit",
		});
		expect(snapshot?.alerts.map((alert) => alert.kind)).not.toContain("gateway_errors");
	});
});

/** A store over `env.DB` that adds up `meta.rows_written` of every batch it sends. */
function countingDeps(deps: TickDeps): { readonly deps: TickDeps; readonly written: () => number } {
	let written = 0;
	const db = new Proxy(env.DB, {
		get(target, property) {
			if (property === "batch") {
				return async (statements: D1PreparedStatement[]) => {
					const results = await target.batch(statements);
					for (const result of results) written += result.meta.rows_written;
					return results;
				};
			}
			const value: unknown = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return {
		deps: { ...deps, store: createStore(db) },
		written: () => {
			const total = written;
			written = 0;
			return total;
		},
	};
}

describe("the corridor list", () => {
	const config = testConfig({ PROBES_PER_TICK: "1", AMOUNT_TIERS: '{"small":"1"}' });
	/** The testnet listing without Base Sepolia: a smaller list, B. */
	const withoutBase = () => {
		const { "eip155:84532": _, ...rest } = fixtures.testnetDefaults;
		return jsonResponse(200, rest);
	};
	const down = () => jsonResponse(503, { code: "SERVICE_UNAVAILABLE", message: "down" });

	async function tickAt(
		index: number,
		options: { readonly defaults?: () => Response; readonly config?: Config } = {},
	): Promise<{ readonly written: number; readonly current: number }> {
		const slotMs = SCHEDULED + index * 300_000;
		const run = tickHarness({
			startMs: slotMs + 1000,
			config: options.config ?? config,
			scenario: quotedEverywhere,
			...(options.defaults === undefined ? {} : { defaults: options.defaults }),
		});
		const counting = countingDeps(run.deps);
		await runTick(counting.deps, slotMs);
		const snapshot = await run.store.readSnapshot("testnet");
		return { written: counting.written(), current: snapshot?.corridors.length ?? -1 };
	}

	async function lastSeen(): Promise<unknown[]> {
		const { results } = await env.DB.prepare(
			"SELECT last_seen, count(*) AS n FROM corridors GROUP BY last_seen ORDER BY last_seen",
		).all();
		return results;
	}

	it("is not rewritten while it is unchanged", async () => {
		const first = await tickAt(0);
		const second = await tickAt(1);
		expect(first.current).toBe(552);
		expect(second.current).toBe(552);
		expect(await lastSeen()).toStrictEqual([{ last_seen: "2026-11-22T10:35:00.000Z", n: 552 }]);
		expect(second.written).toBeLessThan(first.written / 10);
		for (let index = 2; index < 6; index += 1) {
			expect(await tickAt(index)).toMatchObject({ current: 552, written: second.written });
		}
		expect(await lastSeen()).toStrictEqual([{ last_seen: "2026-11-22T10:35:00.000Z", n: 552 }]);
	});

	it("follows the list from A to B and back to A", async () => {
		expect((await tickAt(0)).current).toBe(552);
		const b = await tickAt(1, { defaults: withoutBase });
		expect(b.current).toBeLessThan(552);
		expect(b.current).toBeGreaterThan(0);
		expect((await tickAt(2, { defaults: withoutBase })).current).toBe(b.current);
		const backToA = await tickAt(3);
		expect(backToA.current).toBe(552);
		expect(backToA.written).toBeGreaterThan(552);
		expect((await tickAt(4)).current).toBe(552);
	});

	it("keeps the list through a failed discovery between two equal lists", async () => {
		const first = await tickAt(0);
		expect((await tickAt(1, { defaults: down })).current).toBe(552);
		const after = await tickAt(2);
		expect(after.current).toBe(552);
		expect(after.written).toBeLessThan(first.written / 10);
		expect(await lastSeen()).toStrictEqual([{ last_seen: "2026-11-22T10:35:00.000Z", n: 552 }]);
	});

	it("converges on a database that holds corridor rows but no stored hash", async () => {
		await tickAt(0);
		await env.DB.prepare("DELETE FROM corridor_sets").run();
		const converging = await tickAt(1);
		expect(converging.written).toBeGreaterThan(552);
		expect(await lastSeen()).toStrictEqual([{ last_seen: "2026-11-22T10:40:00.000Z", n: 552 }]);
		const settled = await tickAt(2);
		expect(settled.written).toBeLessThan(converging.written / 10);
		expect(await lastSeen()).toStrictEqual([{ last_seen: "2026-11-22T10:40:00.000Z", n: 552 }]);
	});
});

describe("publishing on every PUBLISH_EVERY_TICKS-th tick", () => {
	// Ticks of 2 minutes, a publish every 5 ticks: slots that start at :00, :10, :20 and so on.
	const config = testConfig({
		PROBE_CRON: "*/2 * * * *",
		CANARY_CRON: "2,12,22,32,42,52 * * * *",
		PUBLISH_EVERY_TICKS: "5",
		PROBES_PER_TICK: "2",
		AMOUNT_TIERS: '{"small":"1"}',
	});
	const PUBLISH_SLOT = Date.parse("2026-11-22T10:50:00.000Z");
	const TICK_MS = 2 * 60_000;

	async function tickAt(scheduledMs: number) {
		const run = tickHarness({ startMs: scheduledMs + 1000, config, scenario: quotedEverywhere });
		return { tick: await runTick(run.deps, scheduledMs), store: run.store };
	}

	it("stores the probes of the ticks between publishes and publishes them all on the next publish slot", async () => {
		const store = createStore(env.DB);
		for (let before = 4; before >= 1; before -= 1) {
			const { tick } = await tickAt(PUBLISH_SLOT - before * TICK_MS);
			expect(tick.probes).toHaveLength(2);
		}
		expect(await count("ticks")).toBe(4);
		expect(await count("probes")).toBe(8);
		expect(await store.readSnapshotJson("testnet")).toBeNull();

		const { tick } = await tickAt(PUBLISH_SLOT);
		const snapshot = await store.readSnapshot("testnet");
		expect(Date.parse(snapshot?.generatedAt ?? "")).toBeGreaterThanOrEqual(
			Date.parse(tick.finishedAt),
		);
		expect(snapshot?.lastTick?.slotStart).toBe("2026-11-22T10:50:00.000Z");
		expect(snapshot).toMatchObject({ tickIntervalMinutes: 2, publishIntervalMinutes: 10 });
		expect(snapshot?.corridors.filter((corridor) => corridor.condition === "fair")).toHaveLength(
			10,
		);
	});

	it("leaves the stored snapshot untouched on a tick that is not on a publish slot", async () => {
		await tickAt(PUBLISH_SLOT);
		const store = createStore(env.DB);
		const published = await store.readSnapshotJson("testnet");
		expect(published).not.toBeNull();

		const { tick } = await tickAt(PUBLISH_SLOT + TICK_MS);
		expect(tick.probes).toHaveLength(2);
		expect(await count("probes")).toBe(4);
		expect(await store.readSnapshotJson("testnet")).toBe(published);
	});

	it("raises prober_stale after three publish intervals, not three tick intervals", async () => {
		const { tick, store } = await tickAt(PUBLISH_SLOT);
		const finishedMs = Date.parse(tick.finishedAt);
		const staleKinds = async (afterMs: number) =>
			(await readHealth({ config, store, nowMs: finishedMs + afterMs })).health.alerts
				.map((alert) => alert.kind)
				.filter((kind) => kind === "prober_stale");

		// Seven minutes is past three 2-minute ticks, and normal between 10-minute publishes.
		expect(await staleKinds(7 * 60_000)).toStrictEqual([]);
		expect(await staleKinds(30 * 60_000)).toStrictEqual([]);
		expect(await staleKinds(30 * 60_000 + 1)).toStrictEqual(["prober_stale"]);
	});
});
