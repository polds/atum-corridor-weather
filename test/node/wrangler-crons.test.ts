import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { cronIntervalMinutes } from "../../src/domain/cron";
import { slotAt } from "../../src/domain/schedule";

/**
 * The values one cron field takes. Handles a number, a star, a range, a step over
 * either, and comma lists of these: enough for the committed cron expressions.
 */
function fieldValues(field: string, max: number): number[] {
	return field.split(",").flatMap((part) => {
		const [range = "", step = "1"] = part.split("/");
		const [from = "", to = from] = range === "*" ? ["0", String(max)] : range.split("-");
		// `n/s` steps from n to the end of the field.
		const last = part.includes("/") && !range.includes("-") ? max : Number(to);
		const values: number[] = [];
		for (let value = Number(from); value <= last; value += Number(step)) values.push(value);
		return values;
	});
}

/** Minutes of the day a cron fires that has a star in each of its last three fields. */
function minutesOfDay(cron: string): number[] {
	const [minute = "", hour = "", ...rest] = cron.split(" ");
	expect(rest, cron).toStrictEqual(["*", "*", "*"]);
	return fieldValues(hour, 23).flatMap((h) => fieldValues(minute, 59).map((m) => h * 60 + m));
}

/** wrangler.jsonc as Wrangler reads it: JSON with comments. */
function wranglerConfig(): { triggers?: { crons?: string[] }; vars?: Record<string, string> } {
	// Vitest runs from the repository root.
	const path = "wrangler.jsonc";
	const { config, error } = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
	if (error !== undefined) throw new Error("wrangler.jsonc does not parse");
	return config;
}

describe("wrangler.jsonc Cron Triggers", () => {
	it("are exactly the probe, canary and maintenance crons, three different expressions", () => {
		const config = wranglerConfig();
		const crons = config.triggers?.crons ?? [];
		const named = [
			config.vars?.PROBE_CRON,
			config.vars?.CANARY_CRON,
			config.vars?.MAINTENANCE_CRON,
		];
		// scheduled() compares controller.cron with each, character for character, and
		// ignores any other trigger.
		for (const cron of named) expect(cron).toEqual(expect.any(String));
		expect(new Set(named).size).toBe(3);
		expect([...crons].sort()).toStrictEqual([...named].sort());
	});

	it("give the probe cron one fixed interval, which is the tick interval", () => {
		const probe = wranglerConfig().vars?.PROBE_CRON ?? "";
		expect(cronIntervalMinutes(probe), probe).toEqual(expect.any(Number));
	});

	it("run the canary a few minutes after each publish, before the next one", () => {
		const vars = wranglerConfig().vars ?? {};
		const tick = cronIntervalMinutes(vars.PROBE_CRON ?? "") ?? 0;
		const every = Number(vars.PUBLISH_EVERY_TICKS ?? "1");
		const publishInterval = tick * every;
		const day = Date.UTC(2026, 10, 22);
		// A tick publishes when its slot index is a multiple of PUBLISH_EVERY_TICKS.
		const publishes = new Set<number>();
		for (let minute = 0; minute < 1440; minute += tick) {
			const slot = slotAt({
				network: "testnet",
				epochMs: day + minute * 60_000,
				intervalMinutes: tick,
			});
			if (slot.index % every === 0) publishes.add((Date.parse(slot.start) - day) / 60_000);
		}
		const canaries = minutesOfDay(vars.CANARY_CRON ?? "");
		expect(publishes.size).toBeGreaterThan(0);
		for (const publish of publishes) {
			const after = canaries.filter((m) => m > publish && m < publish + publishInterval);
			expect(after.length, `publish at minute ${publish}`).toBeGreaterThan(0);
		}
	});

	it("run maintenance once a day, at a minute with no publish and no canary", () => {
		const vars = wranglerConfig().vars ?? {};
		const [minute = -1, ...more] = minutesOfDay(vars.MAINTENANCE_CRON ?? "");
		expect(more).toStrictEqual([]);
		const tick = cronIntervalMinutes(vars.PROBE_CRON ?? "") ?? 0;
		const every = Number(vars.PUBLISH_EVERY_TICKS ?? "1");
		expect(minute % (tick * every), "a publish slot").not.toBe(0);
		expect(minutesOfDay(vars.CANARY_CRON ?? "")).not.toContain(minute);
	});

	it("leave no separate tick interval to fall out of step with the cron", () => {
		expect(wranglerConfig().vars).not.toHaveProperty("TICK_INTERVAL_MINUTES");
	});
});
