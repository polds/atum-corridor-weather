// Writes the Wrangler config a deploy uses: wrangler.jsonc with the deployer's
// own D1 database id. The committed file holds a placeholder id, so a fork never
// carries the upstream's database. The output is not committed.
//
// Usage: D1_DATABASE_ID=<uuid> [REPOSITORY_URL=<https url>] \
//          node scripts/render-deploy-config.mjs [wrangler.jsonc] [wrangler.deploy.jsonc]

import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const PLACEHOLDER_DATABASE_ID = "00000000-0000-0000-0000-000000000000";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const D1_BINDING = "DB";

const input = process.argv[2] ?? "wrangler.jsonc";
const output = process.argv[3] ?? "wrangler.deploy.jsonc";
const databaseId = (process.env.D1_DATABASE_ID ?? "").trim();
const repositoryUrl = (process.env.REPOSITORY_URL ?? "").trim();

const { config, error } = ts.parseConfigFileTextToJson(input, readFileSync(input, "utf8"));
if (error) {
	console.error(
		`${input}: cannot parse: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`,
	);
	process.exit(1);
}

const problems = [];

if (databaseId === "") {
	problems.push(
		"D1_DATABASE_ID is not set. Set it to the id that `wrangler d1 create corridor-weather` printed.",
	);
} else if (!UUID.test(databaseId)) {
	problems.push("D1_DATABASE_ID is not a UUID.");
} else if (databaseId === PLACEHOLDER_DATABASE_ID) {
	problems.push("D1_DATABASE_ID is the placeholder id, not a real database.");
}

const database = (config?.d1_databases ?? []).find((entry) => entry.binding === D1_BINDING);
if (database === undefined) {
	problems.push(`${input} has no d1_databases entry with binding "${D1_BINDING}".`);
}

let repository = null;
if (repositoryUrl !== "") {
	repository = URL.canParse(repositoryUrl) ? new URL(repositoryUrl) : null;
	if (repository === null || repository.protocol !== "https:") {
		problems.push("REPOSITORY_URL is not an https URL.");
	}
}

if (problems.length > 0) {
	for (const problem of problems) console.error(`render-deploy-config: ${problem}`);
	process.exit(1);
}

database.database_id = databaseId;
if (repository !== null) config.vars = { ...config.vars, REPOSITORY_URL: repositoryUrl };

const header = `// Generated from ${input} by scripts/render-deploy-config.mjs. Do not edit or commit.\n`;
writeFileSync(output, `${header}${JSON.stringify(config, null, "\t")}\n`);
console.log(
	`${output}: written from ${input} with the D1 database id from D1_DATABASE_ID` +
		(repository === null ? "." : " and REPOSITORY_URL from the environment."),
);
