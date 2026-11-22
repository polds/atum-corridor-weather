import { describe, expect, it } from "vitest";
import { conditionOf } from "../../src/domain/conditions";

describe("conditionOf", () => {
	it("is fair when every probed tier was quoted", () => {
		expect(conditionOf([{ outcome: "quoted" }, { outcome: "quoted" }])).toBe("fair");
	});
	it("is cloudy when some tiers were quoted and some were not", () => {
		expect(conditionOf([{ outcome: "quoted" }, { outcome: "declined" }])).toBe("cloudy");
	});
	it("is stormy when no tier was quoted", () => {
		expect(conditionOf([{ outcome: "silent" }, { outcome: "gateway_error" }])).toBe("stormy");
	});
	it("is unknown when the corridor was never probed", () => {
		expect(conditionOf([])).toBe("unknown");
	});
});
