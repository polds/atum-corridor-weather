import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runTick } from "../../src/worker/tick";
import { clearTables } from "../support/db";
import { jsonResponse } from "../support/fake-gateway";
import { fixtures, QUOTED_SETTLER } from "../support/fixtures";
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
