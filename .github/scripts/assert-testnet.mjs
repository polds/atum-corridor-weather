// Fails unless the Wrangler config deploys with `vars.NETWORK` set to "testnet".
// The deploy workflow runs it before it touches Cloudflare. Mainnet waits on
// docs/DESIGN.md questions 1 and 4.
//
// Usage: node .github/scripts/assert-testnet.mjs [path to wrangler.jsonc]

import { readFileSync } from "node:fs";
import ts from "typescript";

const path = process.argv[2] ?? "wrangler.jsonc";
const { config, error } = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));

if (error) {
	console.error(
		`${path}: cannot parse: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`,
	);
	process.exit(1);
}

const network = config?.vars?.NETWORK;
if (network !== "testnet") {
	console.error(
		`${path}: vars.NETWORK is ${JSON.stringify(network)}. This workflow deploys testnet only. ` +
			"Mainnet needs the decisions in docs/DESIGN.md, questions 1 and 4.",
	);
	process.exit(1);
}

console.log(`${path}: vars.NETWORK is "testnet".`);
