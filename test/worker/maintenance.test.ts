import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, dayAt, type UtcDay } from "../../src/domain/retention";
import type { ProbeOutcome, RawExchange } from "../../src/domain/types";
import { createStore } from "../../src/store/store";
import { runMaintenance } from "../../src/worker/maintenance";
import { publishSnapshot } from "../../src/worker/tick";
import { clearTables } from "../support/db";
import { ARB_TO_BASE_USDC, corridorById, testnetCorridors } from "../support/fixtures";
import { count, declinedFor, QUOTED, quotedBy, storeTick } from "../support/probes";
import { corridorId, iso } from "../support/readings";
import { testConfig } from "../support/tick";

/** Every run below is the committed daily run, at 03:37 UTC on 2026-11-23. */
const NOW = Date.parse("2026-11-23T03:37:00.000Z");
const TODAY = dayAt(NOW);
const ARB = corridorById(ARB_TO_BASE_USDC);
/** A corridor with no peg to face value, so its quotes carry no spread. */
const OTHER = testnetCorridors.find((corridor) => corridor.id !== ARB.id);
if (OTHER === undefined) throw new Error("the testnet fixture has one corridor");

const SILENT: ProbeOutcome = { kind: "silent", requestedCount: 3 };
const INCOMPLETE: ProbeOutcome = { kind: "incomplete" };
const GATEWAY_ERROR: ProbeOutcome = {
	kind: "gateway_error",
	phase: "poll",
	httpStatus: 500,
	code: null,
	message: "boom",
};
const RAW: readonly RawExchange[] = [
	{
		at: iso("2026-11-22T10:00:01.000Z"),
		method: "GET",
		path: "/v1/payments/quote-requests/qr",
		requestBody: null,
		status: 200,
		latencyMs: 40,
		responseBody: '{"status":"ready"}',
		error: null,
	},
];

const store = createStore(env.DB);

function day(offset: number): UtcDay {
	return addDays(TODAY, offset);
}

/** One tick at 10:00 on `day`: a quoted small probe with raw exchanges, a declined large one. */
async function storeDay(target: UtcDay): Promise<void> {
	await storeTick(store, `${target}T10:00:00.000Z`, [
		{ outcome: QUOTED, raw: RAW },
		{ outcome: declinedFor([{ reason: "INTERNAL", count: 1 }]), tier: "large" },
	]);
}

async function rowsOfDay(target: UtcDay): Promise<Record<string, number>> {
	const like = `cw1.testnet.${target.replaceAll("-", "")}%`;
	const counted = async (sql: string, value: string) =>
		Number(await env.DB.prepare(sql).bind(value).first("n"));
	return {
		probes: await counted("SELECT count(*) AS n FROM probes WHERE id LIKE ?1", like),
		declines: await counted(
			"SELECT count(*) AS n FROM probe_declines WHERE probe_id LIKE ?1",
			like,
		),
		raw: await counted("SELECT count(*) AS n FROM probe_raw WHERE probe_id LIKE ?1", like),
		ticks: await counted("SELECT count(*) AS n FROM ticks WHERE slot_start LIKE ?1", `${target}%`),
	};
}

const FULL_DAY = { probes: 2, declines: 1, raw: 2, ticks: 1 };
const EMPTY_DAY = { probes: 0, declines: 0, raw: 0, ticks: 0 };

function maintain(overrides: Readonly<Record<string, string>> = {}, nowMs = NOW) {
	return runMaintenance({ config: testConfig(overrides), store, now: () => nowMs });
}

/** Every row of every table the maintenance run touches, to compare two states. */
async function everything(): Promise<unknown[]> {
	const tables = ["probes", "probe_declines", "probe_raw", "ticks", "daily_stats"];
	return Promise.all(
		tables.map(
			async (table) => (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()).results,
		),
	);
}

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
	await clearTables();
	info = vi.spyOn(console, "info").mockImplementation(() => {});
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("daily figures", () => {
	it("are what the day's probes say, per corridor and tier", async () => {
		const yesterday = day(-1);
		const at = (hour: string) => `${yesterday}T${hour}:00:00.000Z`;
		const small = async (hour: string, outcome: ProbeOutcome, firstQuoteMs?: number) =>
			storeTick(store, at(hour), [
				{ outcome, ...(firstQuoteMs === undefined ? {} : { firstQuoteMs }) },
			]);
		await small(
			"10",
			quotedBy([
				{ operator: "0xa1", spreadBps: 2 },
				{ operator: "0xb2", spreadBps: 5 },
			]),
			400,
		);
		await small("12", quotedBy([{ operator: "0xa1", spreadBps: 6 }]), 800);
		await storeTick(store, at("14"), [
			{
				outcome: declinedFor([
					{ reason: "INTERNAL", count: 1 },
					{ reason: "INSUFFICIENT_LIQUIDITY", count: 2 },
				]),
			},
			{ outcome: declinedFor([{ reason: "INSUFFICIENT_LIQUIDITY", count: 1 }]), tier: "large" },
			{
				outcome: quotedBy([{ operator: "0xc3", spreadBps: null }]),
				corridor: OTHER,
				firstQuoteMs: 500,
			},
		]);
		await small("16", declinedFor([{ reason: "INSUFFICIENT_LIQUIDITY", count: 1 }]));
		await small("18", SILENT);
		await small("20", GATEWAY_ERROR);
		await small("22", INCOMPLETE);
		// The neighbouring days, whose probes are not part of yesterday.
		await storeTick(store, `${day(-2)}T23:58:00.000Z`, [{ outcome: QUOTED }]);
		await storeTick(store, `${TODAY}T00:00:00.000Z`, [{ outcome: QUOTED }]);

		const run = await maintain();

		expect(run.figuresDays).toStrictEqual([day(-2), yesterday]);
		const arb = await store.readDailyFigures("testnet", ARB.id, [yesterday, TODAY]);
		expect(arb.sort((a, b) => a.tier.localeCompare(b.tier))).toStrictEqual([
			{
				day: yesterday,
				tier: "large",
				probes: 1,
				outcomes: { quoted: 0, declined: 1, silent: 0, incomplete: 0, gateway_error: 0 },
				bestSpreadBps: null,
				maxOperatorCount: 0,
				firstQuoteMs: null,
				declines: [{ reason: "INSUFFICIENT_LIQUIDITY", count: 1 }],
			},
			{
				day: yesterday,
				tier: "small",
				probes: 7,
				outcomes: { quoted: 2, declined: 2, silent: 1, incomplete: 1, gateway_error: 1 },
				bestSpreadBps: { min: 2, mean: 4, max: 6 },
				maxOperatorCount: 2,
				firstQuoteMs: { min: 400, mean: 600, max: 800 },
				declines: [
					{ reason: "INSUFFICIENT_LIQUIDITY", count: 3 },
					{ reason: "INTERNAL", count: 1 },
				],
			},
		]);
		expect(await store.readDailyFigures("testnet", OTHER.id, [yesterday])).toStrictEqual([
			{
				day: yesterday,
				tier: "small",
				probes: 1,
				outcomes: { quoted: 1, declined: 0, silent: 0, incomplete: 0, gateway_error: 0 },
				bestSpreadBps: null,
				maxOperatorCount: 1,
				firstQuoteMs: { min: 500, mean: 500, max: 500 },
				declines: [],
			},
		]);
		expect(await store.readDailyFigures("testnet", ARB.id, [day(-2)])).toMatchObject([
			{ day: day(-2), tier: "small", probes: 1 },
		]);
	});

	it("leave today, and yesterday until a quarter hour past midnight, for a later run", async () => {
		await storeTick(store, `${day(-1)}T23:58:00.000Z`, [{ outcome: QUOTED }]);
		await storeTick(store, `${TODAY}T00:00:00.000Z`, [{ outcome: QUOTED }]);
		const midnight = Date.parse(`${TODAY}T00:00:00.000Z`);
		expect((await maintain({}, midnight + 14 * 60_000)).figuresDays).toStrictEqual([]);
		expect((await maintain({}, midnight + 15 * 60_000)).figuresDays).toStrictEqual([day(-1)]);
	});

	it("are written for at most three days in one run, oldest first", async () => {
		for (const offset of [-5, -4, -3, -2, -1]) await storeDay(day(offset));
		expect((await maintain()).figuresDays).toStrictEqual([day(-5), day(-4), day(-3)]);
		expect((await maintain()).figuresDays).toStrictEqual([day(-2), day(-1)]);
		expect((await maintain()).figuresDays).toStrictEqual([]);
	});

	it("read the probes of their own day and no other", async () => {
		const six = testnetCorridors.slice(0, 6).map((corridor) => ({ outcome: QUOTED, corridor }));
		for (let offset = -12; offset <= -1; offset += 1) {
			await storeTick(store, `${day(offset)}T10:00:00.000Z`, six);
		}
		const { usage } = await store.writeDailyFigures("testnet", [day(-1)], 1);
		// One day holds 6 probes; the other eleven hold 66, which a scan would read.
		expect(usage).toMatchObject({ rowsWritten: 6 });
		expect(usage.rowsRead).toBeLessThan(66);
	});

	it("expire after DAILY_RETENTION_DAYS, one day a run", async () => {
		// DAILY_RETENTION_DAYS=180 keeps today and the 180 days before it.
		const [older, old] = [day(-181), day(-180)];
		await storeDay(older);
		await storeDay(old);
		// A run soon after those days writes their figures and deletes nothing.
		const early = await maintain({}, Date.parse(`${addDays(old, 2)}T03:37:00.000Z`));
		expect(early).toMatchObject({ figuresDays: [older, old], figuresDayDeleted: null });

		const run = await maintain();
		expect(run).toMatchObject({ probesDayDeleted: older, figuresDayDeleted: older });
		const figures = await store.readDailyFigures("testnet", ARB.id, [older, old]);
		expect(figures.map((entry) => entry.day)).toStrictEqual([old, old]);
	});
});

describe("the maintenance run", () => {
	it("deletes the one oldest expired day of probes, with its declines, raw exchanges and ticks", async () => {
		// PROBE_RETENTION_DAYS=14 keeps today and the 14 days before it.
		for (const offset of [-15, -14, -1]) await storeDay(day(offset));
		const run = await maintain({ RAW_RETENTION_DAYS: "14" });

		expect(run).toMatchObject({
			figuresDays: [day(-15), day(-14), day(-1)],
			probesDayDeleted: day(-15),
			rawDayDeleted: null,
			figuresDayDeleted: null,
			backlogDays: 0,
		});
		expect(await rowsOfDay(day(-15))).toStrictEqual(EMPTY_DAY);
		expect(await rowsOfDay(day(-14))).toStrictEqual(FULL_DAY);
		expect(await rowsOfDay(day(-1))).toStrictEqual(FULL_DAY);
		expect(await store.readDailyFigures("testnet", ARB.id, [day(-15)])).toHaveLength(2);
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "maintenance",
				databaseBytes: expect.any(Number),
				rowsWritten: expect.any(Number),
			}),
		);
		expect(warn).not.toHaveBeenCalled();
	});

	it("deletes one day of three waiting and warns of the backlog", async () => {
		for (const offset of [-17, -16, -15]) await storeDay(day(offset));
		const run = await maintain({ RAW_RETENTION_DAYS: "14" });
		// The raw exchanges of the next expired day go on their own clock, one day a run.
		expect(run).toMatchObject({
			probesDayDeleted: day(-17),
			rawDayDeleted: day(-16),
			backlogDays: 2,
		});
		expect(await rowsOfDay(day(-17))).toStrictEqual(EMPTY_DAY);
		expect(await rowsOfDay(day(-16))).toStrictEqual({ ...FULL_DAY, raw: 0 });
		expect(await rowsOfDay(day(-15))).toStrictEqual(FULL_DAY);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "maintenance_backlog", days: 2 }),
		);
	});

	it("changes nothing when it runs a second time", async () => {
		for (const offset of [-15, -4, -1]) await storeDay(day(offset));
		expect(await maintain()).toMatchObject({
			probesDayDeleted: day(-15),
			rawDayDeleted: day(-4),
			backlogDays: 0,
		});
		const after = await everything();
		const again = await maintain();
		expect(again).toMatchObject({
			figuresDays: [],
			probesDayDeleted: null,
			rawDayDeleted: null,
			figuresDayDeleted: null,
			rowsWritten: 0,
		});
		expect(await everything()).toStrictEqual(after);
	});

	it("deletes raw exchanges after RAW_RETENTION_DAYS and keeps the probes", async () => {
		for (const offset of [-4, -3]) await storeDay(day(offset));
		const run = await maintain({ RAW_RETENTION_DAYS: "3" });
		expect(run).toMatchObject({ probesDayDeleted: null, rawDayDeleted: day(-4) });
		expect(await rowsOfDay(day(-4))).toStrictEqual({ ...FULL_DAY, raw: 0 });
		expect(await rowsOfDay(day(-3))).toStrictEqual(FULL_DAY);
	});

	it("deletes the ticks of an expired day that has no probes", async () => {
		await storeTick(store, `${day(-15)}T10:00:00.000Z`, []);
		await storeDay(day(-1));
		const run = await maintain();
		expect(run).toMatchObject({ probesDayDeleted: day(-15), backlogDays: 0 });
		expect(await count("ticks")).toBe(1);
	});

	it("keeps quotes_lost and the latest readings working after it deleted a day", async () => {
		const other = OTHER;
		// ARB quoted on a day that is deleted, quoted again 3 days ago and declined yesterday.
		// The other corridor quoted only on the deleted day.
		await storeTick(store, `${day(-15)}T10:00:00.000Z`, [
			{ outcome: QUOTED },
			{ outcome: QUOTED, corridor: other },
		]);
		await storeTick(store, `${day(-3)}T10:00:00.000Z`, [{ outcome: QUOTED }]);
		await storeTick(store, `${day(-1)}T10:00:00.000Z`, [
			{ outcome: declinedFor([{ reason: "INTERNAL", count: 1 }]) },
		]);
		expect(await maintain()).toMatchObject({ probesDayDeleted: day(-15) });

		const snapshot = await publishSnapshot({
			config: testConfig({ AMOUNT_TIERS: '{"small":"1"}' }),
			store,
			now: () => NOW,
		});
		const arb = snapshot.corridors.find((corridor) => corridor.id === ARB.id);
		expect(arb).toMatchObject({
			condition: "stormy",
			tiers: [{ outcome: "declined", probedAt: `${day(-1)}T10:00:01.000Z` }],
		});
		expect(snapshot.corridors.find((corridor) => corridor.id === other.id)).toMatchObject({
			condition: "unknown",
			tiers: [],
		});
		expect(snapshot.alerts.filter((alert) => alert.kind === "quotes_lost")).toStrictEqual([
			expect.objectContaining({
				corridorId: corridorId(ARB.id),
				since: `${day(-1)}T10:00:01.000Z`,
			}),
		]);
	});
});

describe("deleting a day of probes", () => {
	it("keeps a day that has probes and no figures", async () => {
		await storeDay(day(-20));
		expect(await store.deleteProbeDay("testnet", day(-20))).toMatchObject({ deleted: false });
		expect(await rowsOfDay(day(-20))).toStrictEqual(FULL_DAY);
	});
});
