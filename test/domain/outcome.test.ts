import { describe, expect, it } from "vitest";
import { isAtomicAmount, isIsoTimestamp } from "../../src/domain/brands";
import { classifyOutcome, type SeenQuote } from "../../src/domain/outcome";
import { probeTargets } from "../../src/domain/schedule";
import type { ProbeTarget } from "../../src/domain/types";
import { ARB_TO_BASE_USDC, corridorById } from "../support/fixtures";

const [target] = probeTargets([corridorById(ARB_TO_BASE_USDC)], { small: "1" });

function quote(id: string, settler: string, amount: string, firstSeen: string): SeenQuote {
	const deadline = "2026-11-22T10:38:05.812Z";
	if (!isAtomicAmount(amount) || !isIsoTimestamp(deadline)) throw new Error("bad quote");
	return {
		quoteId: id,
		settlerAddress: settler,
		sourceAmount: amount,
		awardDeadline: deadline,
		firstSeenMs: Date.parse(firstSeen),
	};
}

function classify(final: Parameters<typeof classifyOutcome>[1]) {
	if (target === undefined) throw new Error("no target");
	return classifyOutcome(target satisfies ProbeTarget, final);
}

describe("classifyOutcome", () => {
	it("is quoted with spread and price hold when a quote is listed", () => {
		const outcome = classify({
			status: "ready",
			quotes: [quote("q1", "0xsettler", "1000200", "2026-11-22T10:37:06.211Z")],
			declines: [],
			requestedCount: 1,
		});
		expect(outcome).toStrictEqual({
			kind: "quoted",
			quotes: [
				{
					quoteId: "q1",
					settlerAddress: "0xsettler",
					sourceAmount: "1000200",
					awardDeadline: "2026-11-22T10:38:05.812Z",
					spreadBps: 2,
					priceHoldMs: 59_601,
				},
			],
			declines: [],
			requestedCount: 1,
		});
	});

	it("stays quoted when quotes have lapsed and keeps the declines beside them", () => {
		const outcome = classify({
			status: "expired",
			quotes: [quote("q1", "0xa", "1000100", "2026-11-22T10:37:06.000Z")],
			declines: [{ reason: "INSUFFICIENT_LIQUIDITY", retryClassification: null, count: 2 }],
			requestedCount: null,
		});
		expect(outcome.kind).toBe("quoted");
		expect(outcome).toHaveProperty("declines", [
			{ reason: "INSUFFICIENT_LIQUIDITY", retryClassification: null, count: 2 },
		]);
	});

	it("is declined with unknown reasons kept verbatim", () => {
		expect(
			classify({
				status: "ready",
				quotes: [],
				declines: [
					{ reason: "BRAND_NEW_REASON", retryClassification: "CONTACT_SUPPORT", count: 1 },
				],
				requestedCount: 3,
			}),
		).toStrictEqual({
			kind: "declined",
			declines: [{ reason: "BRAND_NEW_REASON", retryClassification: "CONTACT_SUPPORT", count: 1 }],
			requestedCount: 3,
		});
	});

	it("is silent with no quote and no decline, and keeps an absent count as unknown", () => {
		expect(
			classify({ status: "ready", quotes: [], declines: null, requestedCount: null }),
		).toStrictEqual({
			kind: "silent",
			requestedCount: null,
		});
		expect(
			classify({ status: "ready", quotes: [], declines: [], requestedCount: 0 }),
		).toStrictEqual({
			kind: "silent",
			requestedCount: 0,
		});
	});

	it("is incomplete when the batch was still collecting, even with quotes so far", () => {
		expect(
			classify({
				status: "collecting",
				quotes: [quote("q1", "0xa", "1000200", "2026-11-22T10:37:06.000Z")],
				declines: [],
				requestedCount: 1,
			}),
		).toStrictEqual({ kind: "incomplete" });
	});
});
