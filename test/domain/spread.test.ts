import { describe, expect, it } from "vitest";
import { isAtomicAmount } from "../../src/domain/brands";
import { spreadBps } from "../../src/domain/spread";
import type { AtomicAmount } from "../../src/domain/types";

function atomic(value: string): AtomicAmount {
	if (!isAtomicAmount(value)) throw new Error(value);
	return value;
}

function spread(
	source: [string, number, string],
	destination: [string, number, string],
): number | null {
	return spreadBps({
		sourceAmount: atomic(source[0]),
		sourceDecimals: source[1],
		sourceSymbol: source[2],
		fulfillmentAmount: atomic(destination[0]),
		destinationDecimals: destination[1],
		destinationSymbol: destination[2],
	});
}

describe("spreadBps", () => {
	it("is 2 bps for the quoted fixture, 1.0002 USDC for 1 USDC", () => {
		expect(spread(["1000200", 6, "USDC"], ["1000000", 6, "USDC"])).toBe(2);
	});

	it("is negative when the source pays less than face value", () => {
		expect(spread(["999900", 6, "USDT"], ["1000000", 6, "USDC"])).toBe(-1);
	});

	it("compares whole tokens across different decimals", () => {
		expect(spread(["1000500", 6, "USDC"], ["1000000000000000000", 18, "USDT0"])).toBe(5);
	});

	it("rounds half away from zero to two decimals", () => {
		expect(spread(["10000005", 7, "pathUSD"], ["1000000", 6, "USDC"])).toBe(0.01);
		expect(spread(["9999995", 7, "pathUSD"], ["1000000", 6, "USDC"])).toBe(-0.01);
		expect(spread(["3000001", 6, "USDC"], ["3000000", 6, "USDC"])).toBe(0);
	});

	it("prices GBP against GBP and ETH against ETH", () => {
		expect(spread(["1010000", 6, "GBPA"], ["1000000", 6, "GBPA"])).toBe(100);
		expect(spread(["1001000000000000000", 18, "WETH"], ["1000000000000000000", 18, "WETH"])).toBe(
			10,
		);
	});

	it("is null across pegs, for unknown symbols, and for a zero amount", () => {
		expect(spread(["1000000", 6, "GBPA"], ["1000000", 6, "USDC"])).toBeNull();
		expect(spread(["1000000", 6, "USDC"], ["1000000", 6, "MYSTERY"])).toBeNull();
		expect(spread(["1000000", 6, "constructor"], ["1000000", 6, "constructor"])).toBeNull();
		expect(spread(["1000000", 6, "USDC"], ["0", 6, "USDC"])).toBeNull();
	});
});
