import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const DATABASE_ID = "7f1c2a9e-4b3d-4c5e-8f60-1a2b3c4d5e6f";
const PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

interface WranglerConfig {
	d1_databases: { binding: string; database_id: string }[];
	vars: Record<string, string>;
	triggers: unknown;
}

function parse(path: string): WranglerConfig {
	const { config, error } = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
	if (error !== undefined) throw new Error(`${path} does not parse`);
	return config;
}

/** Runs the script on a copy-free read of the committed wrangler.jsonc. Vitest runs from the repository root. */
function render(
	env: Record<string, string>,
	input = "wrangler.jsonc",
): { status: number; stderr: string; output: string } {
	const output = join(
		mkdtempSync(join(tmpdir(), "render-deploy-config-")),
		"wrangler.deploy.jsonc",
	);
	try {
		execFileSync("node", ["scripts/render-deploy-config.mjs", input, output], {
			// Both variables are cleared first, so a value in the caller's environment cannot leak into a case.
			env: { ...process.env, D1_DATABASE_ID: "", REPOSITORY_URL: "", ...env },
			stdio: "pipe",
		});
		return { status: 0, stderr: "", output };
	} catch (error) {
		const failed = error as { status: number; stderr: Buffer };
		return { status: failed.status, stderr: failed.stderr.toString(), output };
	}
}

describe("the committed wrangler.jsonc", () => {
	it("holds the placeholder database id, so a fork carries nobody's database", () => {
		expect(parse("wrangler.jsonc").d1_databases).toMatchObject([
			{ binding: "DB", database_id: PLACEHOLDER },
		]);
	});
});

describe("render-deploy-config", () => {
	it("writes the config with the database id from D1_DATABASE_ID and changes nothing else", () => {
		const result = render({ D1_DATABASE_ID: DATABASE_ID });
		expect(result.status).toBe(0);

		const committed = parse("wrangler.jsonc");
		const rendered = parse(result.output);
		expect(rendered.d1_databases[0]?.database_id).toBe(DATABASE_ID);
		committed.d1_databases[0] = {
			...committed.d1_databases[0],
			binding: "DB",
			database_id: DATABASE_ID,
		};
		expect(rendered).toStrictEqual(committed);
	});

	it("sets REPOSITORY_URL when the environment gives one", () => {
		const result = render({
			D1_DATABASE_ID: DATABASE_ID,
			REPOSITORY_URL: "https://github.com/someone/their-fork",
		});
		expect(result.status).toBe(0);
		expect(parse(result.output).vars.REPOSITORY_URL).toBe("https://github.com/someone/their-fork");
	});

	it.each([
		["no id", {}, /D1_DATABASE_ID is not set/],
		["an empty id", { D1_DATABASE_ID: "  " }, /D1_DATABASE_ID is not set/],
		["an id that is not a UUID", { D1_DATABASE_ID: "corridor-weather" }, /not a UUID/],
		["the placeholder id", { D1_DATABASE_ID: PLACEHOLDER }, /placeholder/],
		[
			"a repository URL that is not https",
			{ D1_DATABASE_ID: DATABASE_ID, REPOSITORY_URL: "http://github.com/a/b" },
			/REPOSITORY_URL is not an https URL/,
		],
	])("refuses %s and writes no file", (_name, env, message) => {
		const result = render(env);
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(message);
		expect(() => readFileSync(result.output)).toThrow();
	});

	it("refuses a config with no DB binding", () => {
		const input = join(mkdtempSync(join(tmpdir(), "render-deploy-config-")), "wrangler.jsonc");
		writeFileSync(input, '{ "name": "x", "d1_databases": [] }');
		const result = render({ D1_DATABASE_ID: DATABASE_ID }, input);
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/no d1_databases entry with binding "DB"/);
	});
});
