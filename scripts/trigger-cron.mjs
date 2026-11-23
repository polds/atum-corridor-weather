// Fires one of the Worker's three crons on a local `pnpm run dev`. It reads the
// expression from wrangler.jsonc, so it keeps working when the cadence changes.
// scheduled() ignores a cron it does not know, so the expression must be exact.
//
// Usage: node scripts/trigger-cron.mjs probe|canary|maintenance [http://localhost:8787]

import { readFileSync } from "node:fs";
import ts from "typescript";

const VARS = { probe: "PROBE_CRON", canary: "CANARY_CRON", maintenance: "MAINTENANCE_CRON" };

const [which, base = "http://localhost:8787"] = process.argv.slice(2);
const name = VARS[which];
if (name === undefined) {
	console.error(
		"Usage: node scripts/trigger-cron.mjs probe|canary|maintenance [http://localhost:8787]",
	);
	process.exit(1);
}

const { config, error } = ts.parseConfigFileTextToJson(
	"wrangler.jsonc",
	readFileSync("wrangler.jsonc", "utf8"),
);
const cron = config?.vars?.[name];
if (error || typeof cron !== "string") {
	console.error(`wrangler.jsonc: cannot read vars.${name}`);
	process.exit(1);
}

const url = `${base}/__scheduled?cron=${encodeURIComponent(cron)}`;
try {
	const response = await fetch(url);
	console.log(`${name} "${cron}": ${response.status} ${(await response.text()).trim()}`);
	if (!response.ok) process.exit(1);
} catch {
	console.error(`${url}: no answer. Start the Worker with \`pnpm run dev\` first.`);
	process.exit(1);
}
