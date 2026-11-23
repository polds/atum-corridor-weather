import { describe, expect, it } from "vitest";
import {
	batchFor,
	isSha256Hex,
	probeIdFor,
	probesPlannedPerTick,
	probeTargets,
	SUBREQUEST_RESERVE,
	slotAt,
} from "../../src/domain/schedule";
import type { TickSlot } from "../../src/domain/types";
import { ARB_TO_BASE_USDC, corridorById, testnetCorridors } from "../support/fixtures";

const SLOT_1035: TickSlot = slotAt({
	network: "testnet",
	epochMs: Date.parse("2026-11-22T10:37:42.123Z"),
	intervalMinutes: 5,
});

describe("slotAt", () => {
	it("floors the time to the interval and numbers the slot from the epoch", () => {
		expect(SLOT_1035).toStrictEqual({
			network: "testnet",
			index: 5_984_479,
			start: "2026-11-22T10:35:00.000Z",
		});
	});

	it("maps a retried cron run inside the same interval to the same slot", () => {
		const retried = slotAt({
			network: "testnet",
			epochMs: Date.parse("2026-11-22T10:39:59.999Z"),
			intervalMinutes: 5,
		});
		expect(retried).toStrictEqual(SLOT_1035);
	});
});

describe("probeTargets", () => {
	it("lists every corridor at every configured tier, by corridor then tier", () => {
		const targets = probeTargets(testnetCorridors, { small: "1", typical: "25", large: "250" });
		expect(targets).toHaveLength(552 * 3);
		expect(
			targets.slice(0, 3).map((target) => [target.tier, target.fulfillmentAmount]),
		).toStrictEqual([
			["small", "1000000"],
			["typical", "25000000"],
			["large", "250000000"],
		]);
	});

	it("leaves out tiers that are not configured or not representable", () => {
		const corridor = corridorById(ARB_TO_BASE_USDC);
		expect(probeTargets([corridor], { large: "250" }).map((target) => target.tier)).toStrictEqual([
			"large",
		]);
		expect(probeTargets([corridor], { small: "0.0000001", large: "1" })).toHaveLength(1);
	});
});

describe("batchFor", () => {
	const targets = probeTargets(testnetCorridors.slice(0, 4), { small: "1" });
	const at = (index: number): TickSlot => ({ ...SLOT_1035, index });

	it("starts at slot index times batch size, modulo the target count", () => {
		expect(batchFor(at(0), targets, 3)).toStrictEqual(targets.slice(0, 3));
		expect(batchFor(at(5), targets, 3)).toStrictEqual([targets[3], targets[0], targets[1]]);
	});

	it("never probes one target twice when the batch is larger than the list", () => {
		const batch = batchFor(at(1), targets, 10);
		expect(batch).toHaveLength(4);
		expect(new Set(batch)).toHaveProperty("size", 4);
	});

	it("is empty when there is nothing to probe", () => {
		expect(batchFor(at(7), [], 30)).toStrictEqual([]);
	});
});

describe("probesPlannedPerTick", () => {
	const plan = (probesPerTick: number, subrequestLimit: number) =>
		probesPlannedPerTick({ probesPerTick, subrequestLimit, requestsPerProbe: 7 });

	it("keeps one request for /v1/defaults and the reserve, and fits whole probes in the rest", () => {
		expect(plan(30, 50)).toBe(6);
		expect(plan(30, 10_000)).toBe(30);
		expect(plan(30, 1 + SUBREQUEST_RESERVE + 7)).toBe(1);
		expect(plan(30, 1 + SUBREQUEST_RESERVE + 6)).toBe(0);
		expect(plan(30, 2)).toBe(0);
		expect(plan(5, 50)).toBe(5);
	});

	it("never plans a tick that would send the last request the limit allows", () => {
		for (let limit = 2; limit <= 200; limit += 1) {
			const sent = 1 + plan(30, limit) * 7;
			expect(sent === 1 || sent <= limit - SUBREQUEST_RESERVE, `limit ${limit}`).toBe(true);
		}
	});
});

describe("probeIdFor", () => {
	it("joins prefix, network, slot minute, corridor digest and tier", () => {
		const digest = "7ae33acb9dd621c3187b1572c181cd18aaff47ecd41bd1339bc22781a25b8e9b";
		if (!isSha256Hex(digest)) throw new Error("bad digest");
		const id = probeIdFor({ slot: SLOT_1035, tier: "small", corridorDigest: digest });
		expect(id).toBe("cw1.testnet.20261122T1035Z.7ae33acb9dd6.small");
		expect(id).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
	});

	it("accepts only lower-case 64-digit hex as a digest", () => {
		expect(isSha256Hex("A".repeat(64))).toBe(false);
		expect(isSha256Hex("a".repeat(63))).toBe(false);
	});
});
