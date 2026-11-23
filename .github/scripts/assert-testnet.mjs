// Fails unless the Wrangler config deploys the testnet prober and nothing else.
// The deploy workflow runs it on the config it is about to deploy, before it
// touches Cloudflare, and passes that same file to Wrangler with `--config`, so
// no other config file can take over.
// Mainnet waits on docs/DESIGN.md questions 1 and 4.
//
// Usage: node .github/scripts/assert-testnet.mjs [path to the Wrangler config]

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";

const TESTNET_GATEWAY = "https://payment-gw.production-testnet.atum.xyz";

const path = process.argv[2] ?? "wrangler.jsonc";
const { config, error } = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));

if (error) {
	console.error(
		`${path}: cannot parse: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`,
	);
	process.exit(1);
}

const problems = [];

// Wrangler prefers wrangler.json and wrangler.toml over wrangler.jsonc.
for (const name of ["wrangler.json", "wrangler.toml"]) {
	const other = join(dirname(path), name);
	if (existsSync(other)) {
		problems.push(`${other} exists. Wrangler would read it instead of ${path}. Delete it.`);
	}
}

const vars = config?.vars ?? {};
if (vars.NETWORK !== "testnet") {
	problems.push(
		`vars.NETWORK is ${JSON.stringify(vars.NETWORK)}, not "testnet". ` +
			"Mainnet needs the decisions in docs/DESIGN.md, questions 1 and 4.",
	);
}
if (vars.GATEWAY_URL !== TESTNET_GATEWAY) {
	problems.push(
		`vars.GATEWAY_URL is ${JSON.stringify(vars.GATEWAY_URL)}, not "${TESTNET_GATEWAY}".`,
	);
}
if ((vars.MAINNET_ACK ?? "") !== "") {
	problems.push(
		`vars.MAINNET_ACK is ${JSON.stringify(vars.MAINNET_ACK)}. A testnet deploy leaves it empty.`,
	);
}

if (problems.length > 0) {
	for (const problem of problems) console.error(`${path}: ${problem}`);
	console.error("This workflow deploys testnet only.");
	process.exit(1);
}

console.log(
	`${path}: vars.NETWORK is "testnet", vars.GATEWAY_URL is the testnet gateway, vars.MAINNET_ACK is empty, and no other Wrangler config is present.`,
);
