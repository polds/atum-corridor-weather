import { describe, expect, it } from "vitest";
import { isStale, parseSnapshot } from "../../dashboard/src/model";

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
