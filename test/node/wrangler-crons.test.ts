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
	it("names the canary cron exactly as one trigger, beside exactly one probe cron", () => {
		const config = wranglerConfig();
		const crons = config.triggers?.crons ?? [];
		const canary = config.vars?.CANARY_CRON;
		// scheduled() compares controller.cron with CANARY_CRON character for character.
		expect(crons).toContain(canary);
		expect(crons.filter((cron) => cron !== canary)).toHaveLength(1);
		expect(crons).toHaveLength(2);
	});
});
