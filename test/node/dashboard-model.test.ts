import { describe, expect, it } from "vitest";
import { isStale, parseHistory, parseSnapshot } from "../../dashboard/src/model";

const GENERATED_AT = "2026-11-22T10:50:00.000Z";
const generatedMs = Date.parse(GENERATED_AT);
const MINUTE = 60_000;

/** A snapshot document as `/api/v1/snapshot.json` serves it, with no corridor. */
function document(intervals: Record<string, unknown>): Record<string, unknown> {
	return {
		schemaVersion: 1,
		network: "testnet",
		generatedAt: GENERATED_AT,
		...intervals,
		cadence: { probesPerTick: 6, sweepHours: 9.2 },
		tiers: ["small"],
		lastTick: null,
		assets: [],
		corridors: [],
		alerts: [],
	};
}

function parsed(intervals: Record<string, unknown>) {
	const result = parseSnapshot(document(intervals));
	if (!result.ok) throw new Error(result.reason);
	return result.value;
}

describe("the dashboard's snapshot freshness", () => {
	it("calls a snapshot stale after three publish intervals, not three tick intervals", () => {
		const snapshot = parsed({ tickIntervalMinutes: 2, publishIntervalMinutes: 10 });
		expect(isStale(snapshot, generatedMs + 7 * MINUTE)).toBe(false);
		expect(isStale(snapshot, generatedMs + 30 * MINUTE)).toBe(false);
		expect(isStale(snapshot, generatedMs + 30 * MINUTE + 1)).toBe(true);
	});

	it("reads a snapshot published before publishIntervalMinutes existed as published every tick", () => {
		const snapshot = parsed({ tickIntervalMinutes: 5 });
		expect(snapshot.publishIntervalMinutes).toBe(5);
		expect(isStale(snapshot, generatedMs + 15 * MINUTE)).toBe(false);
		expect(isStale(snapshot, generatedMs + 15 * MINUTE + 1)).toBe(true);
	});

	it("refuses a publish interval that is not a positive number", () => {
		for (const bad of [0, -10, "10", null]) {
			expect(
				parseSnapshot(document({ tickIntervalMinutes: 2, publishIntervalMinutes: bad })).ok,
				String(bad),
			).toBe(false);
		}
	});
});

describe("the dashboard's history parser", () => {
	const history = {
		schemaVersion: 1,
		network: "testnet",
		corridorId: "eip155:1/erc20:0xaa>eip155:2/erc20:0xbb",
		generatedAt: GENERATED_AT,
		days: 7,
		points: [],
	};
	const figures = {
		day: "2026-11-21",
		tier: "small",
		probes: 2,
		outcomes: { quoted: 1, declined: 1, silent: 0, incomplete: 0, gateway_error: 0 },
		bestSpreadBps: { min: 2, mean: 2, max: 2 },
		maxOperatorCount: 1,
		firstQuoteMs: null,
		declines: [{ reason: "INTERNAL", count: 1 }],
	};

	it("reads a history published before daily figures existed as having none", () => {
		expect(parseHistory(history)).toStrictEqual({ ok: true, value: { ...history, daily: [] } });
	});

	it("reads daily figures", () => {
		expect(parseHistory({ ...history, daily: [figures] })).toStrictEqual({
			ok: true,
			value: { ...history, daily: [figures] },
		});
	});

	it("refuses daily figures of the wrong shape", () => {
		for (const bad of [
			{ ...figures, outcomes: { quoted: 1 } },
			{ ...figures, bestSpreadBps: { min: 2 } },
			{ ...figures, declines: [{ reason: "INTERNAL" }] },
			null,
		]) {
			expect(parseHistory({ ...history, daily: [bad] }).ok, JSON.stringify(bad)).toBe(false);
		}
	});
});
