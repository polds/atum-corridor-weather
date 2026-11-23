import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** wrangler.jsonc as Wrangler reads it: JSON with comments. */
function wranglerConfig(): { triggers?: { crons?: string[] }; vars?: Record<string, string> } {
	// Vitest runs from the repository root.
	const path = "wrangler.jsonc";
	const { config, error } = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
	if (error !== undefined) throw new Error("wrangler.jsonc does not parse");
	return config;
}

describe("wrangler.jsonc Cron Triggers", () => {
	it("are exactly the probe cron and the canary cron, two different expressions", () => {
		const config = wranglerConfig();
		const crons = config.triggers?.crons ?? [];
		const probe = config.vars?.PROBE_CRON;
		const canary = config.vars?.CANARY_CRON;
		// scheduled() compares controller.cron with both, character for character, and
		// ignores any other trigger.
		expect(probe).toEqual(expect.any(String));
		expect(canary).toEqual(expect.any(String));
		expect(probe).not.toBe(canary);
		expect([...crons].sort()).toStrictEqual([probe, canary].sort());
	});
});
