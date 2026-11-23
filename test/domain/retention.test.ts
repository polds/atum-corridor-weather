import { describe, expect, it } from "vitest";
import {
	addDays,
	dayAt,
	dayOfProbeId,
	earlierDay,
	expiryOf,
	figureCandidates,
	figureDaysAt,
	isUtcDay,
	probeIdRange,
	type UtcDay,
} from "../../src/domain/retention";
import { isSha256Hex, probeIdFor, slotAt } from "../../src/domain/schedule";

const DIGEST = (() => {
	const hex = "7ae33acb9dd6".padEnd(64, "0");
	if (!isSha256Hex(hex)) throw new Error("not a digest");
	return hex;
})();

function day(text: string): UtcDay {
	if (!isUtcDay(text)) throw new Error(`not a day: ${text}`);
	return text;
}

function idAt(start: string, network: "testnet" | "mainnet" = "testnet"): string {
	const slot = slotAt({ network, epochMs: Date.parse(start), intervalMinutes: 2 });
	return probeIdFor({ slot, tier: "large", corridorDigest: DIGEST });
}

function inRange(id: string, range: { readonly from: string; readonly to: string }): boolean {
	return id >= range.from && id < range.to;
}

describe("a day of probe ids", () => {
	it("holds every probe of the day's slots and none of its neighbours", () => {
		const range = probeIdRange("testnet", day("2026-11-22"));
		expect(inRange(idAt("2026-11-22T00:00:00.000Z"), range)).toBe(true);
		expect(inRange(idAt("2026-11-22T23:58:00.000Z"), range)).toBe(true);
		expect(inRange(idAt("2026-11-21T23:58:00.000Z"), range)).toBe(false);
		expect(inRange(idAt("2026-11-23T00:00:00.000Z"), range)).toBe(false);
		expect(inRange(idAt("2026-11-22T10:00:00.000Z", "mainnet"), range)).toBe(false);
	});

	it("of a network holds every day of that network only", () => {
		const range = probeIdRange("testnet", null);
		expect(inRange(idAt("1999-01-01T00:00:00.000Z"), range)).toBe(true);
		expect(inRange(idAt("2999-12-31T23:58:00.000Z"), range)).toBe(true);
		expect(inRange(idAt("2026-11-22T10:00:00.000Z", "mainnet"), range)).toBe(false);
	});

	it("names the day of its slot", () => {
		expect(dayOfProbeId(idAt("2026-11-22T23:58:00.000Z"))).toBe("2026-11-22");
		expect(dayOfProbeId("cw1.testnet.20261332T0000Z.x.small")).toBeNull();
		expect(dayOfProbeId("old")).toBeNull();
	});
});

describe("days", () => {
	it("are UTC calendar days", () => {
		expect(dayAt(Date.parse("2026-11-22T23:59:59.999Z"))).toBe("2026-11-22");
		expect(addDays(day("2026-02-28"), 1)).toBe("2026-03-01");
		expect(addDays(day("2026-01-01"), -1)).toBe("2025-12-31");
		expect(isUtcDay("2026-02-30")).toBe(false);
		expect(isUtcDay("2026-2-3")).toBe(false);
		expect(earlierDay(day("2026-11-21"), day("2026-11-22"))).toBe("2026-11-21");
		expect(earlierDay(day("2026-11-22"), day("2026-11-21"))).toBe("2026-11-21");
		expect(earlierDay(null, day("2026-11-22"))).toBe("2026-11-22");
		expect(earlierDay(day("2026-11-22"), null)).toBe("2026-11-22");
	});
});

describe("expiry", () => {
	const now = Date.parse("2026-11-23T03:37:00.000Z");

	it("keeps today and the retained days before it", () => {
		expect(expiryOf(day("2026-11-09"), 14, now)).toStrictEqual({ day: null, waiting: 0 });
		expect(expiryOf(day("2026-11-08"), 14, now)).toStrictEqual({ day: "2026-11-08", waiting: 1 });
		expect(expiryOf(day("2026-11-06"), 14, now)).toStrictEqual({ day: "2026-11-06", waiting: 3 });
		expect(expiryOf(null, 14, now)).toStrictEqual({ day: null, waiting: 0 });
	});

	it("still holds a 7-day look-back from any time of day at 8 days", () => {
		const lastMoment = Date.parse("2026-11-23T23:59:59.999Z");
		const oldestKept = addDays(dayAt(lastMoment), -8);
		expect(expiryOf(oldestKept, 8, lastMoment).day).toBeNull();
		expect(Date.parse(`${oldestKept}T00:00:00.000Z`)).toBeLessThan(lastMoment - 7 * 86_400_000);
	});
});

describe("days that need figures", () => {
	it("run from the oldest probe day to the last complete day", () => {
		const now = Date.parse("2026-11-23T03:37:00.000Z");
		expect(figureCandidates(day("2026-11-20"), now)).toStrictEqual([
			"2026-11-20",
			"2026-11-21",
			"2026-11-22",
		]);
		expect(figureCandidates(day("2026-11-23"), now)).toStrictEqual([]);
		expect(figureCandidates(null, now)).toStrictEqual([]);
	});

	it("leave yesterday until no tick of it can still be running", () => {
		const midnight = Date.parse("2026-11-23T00:00:00.000Z");
		expect(figureCandidates(day("2026-11-22"), midnight + 14 * 60_000)).toStrictEqual([]);
		expect(figureCandidates(day("2026-11-22"), midnight + 15 * 60_000)).toStrictEqual([
			"2026-11-22",
		]);
	});
});

describe("the days a history serves figures for", () => {
	it("are the retained days before today", () => {
		const days = figureDaysAt(Date.parse("2026-11-23T12:00:00.000Z"), 3);
		expect(days).toStrictEqual(["2026-11-20", "2026-11-21", "2026-11-22"]);
	});
});
