import { describe, expect, it } from "vitest";
import { toAtomicAmount } from "../../src/domain/amounts";

describe("toAtomicAmount", () => {
	it.each([
		["1", 6, "1000000"],
		["25", 6, "25000000"],
		["250", 6, "250000000"],
		["0.5", 6, "500000"],
		["0.000001", 6, "1"],
		["1.5", 18, "1500000000000000000"],
		["7", 0, "7"],
		["00.50", 2, "50"],
		["1.50", 1, "15"],
		["2.000", 0, "2"],
	])("converts %s whole tokens at %i decimals to %s", (whole, decimals, atomic) => {
		expect(toAtomicAmount(whole, decimals)).toBe(atomic);
	});

	it.each([
		["0.0000001", 6],
		["0.5", 0],
		["-1", 6],
		["1e3", 6],
		["", 6],
		["1.", 6],
		["1", -1],
		["1", 1.5],
	])("rejects %s at %s decimals", (whole, decimals) => {
		expect(toAtomicAmount(whole, decimals)).toBeNull();
	});
});
