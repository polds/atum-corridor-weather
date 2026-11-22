// Checks that the testnet gateway's `GET /v1/defaults` still has the shape the prober reads.
// It sends exactly one GET request and never a quote request. It needs Node 22 and nothing else.
//
// Usage:
//   node .github/scripts/check-gateway-contract.mjs          checks the live testnet listing
//   node .github/scripts/check-gateway-contract.mjs <file>   checks a saved listing instead
//
// Exit code 0 means the shape matches. Exit code 1 means drift, or the request failed.

import { readFile } from "node:fs/promises";

const DEFAULTS_URL = "https://payment-gw.production-testnet.atum.xyz/v1/defaults";
const USER_AGENT =
	"corridor-weather-ci (+https://github.com/polds/atum-corridor-weather; contract check)";

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = {
	test: (value) => typeof value === "string" && value.length > 0,
	want: "a non-empty string",
};
const isDecimals = {
	test: (value) => Number.isInteger(value) && value >= 0,
	want: "a non-negative integer",
};

// The fields the prober reads from each chain and each token. A path with a dot is nested.
const CHAIN_FIELDS = {
	chain_id: isText,
	escrow_contract: isText,
	"fulfillment_verifier.account": isText,
	"fulfillment_verifier.endpoint": isText,
	quote_selector: isText,
};
const TOKEN_FIELDS = { address: isText, decimals: isDecimals, symbol: isText };

const read = (value, path) =>
	path.split(".").reduce((node, key) => (isObject(node) ? node[key] : undefined), value);

function checkFields(value, fields, where, problems) {
	for (const [path, rule] of Object.entries(fields)) {
		const found = read(value, path);
		if (!rule.test(found)) {
			problems.push(`${where}.${path}: expected ${rule.want}, got ${JSON.stringify(found)}`);
		}
	}
}

function checkListing(listing) {
	if (!isObject(listing)) return ["the response is not a JSON object keyed by chain id"];
	const chains = Object.entries(listing);
	if (chains.length === 0) return ["the response lists no chains"];

	const problems = [];
	for (const [key, chain] of chains) {
		if (!isObject(chain)) {
			problems.push(`${key}: expected an object, got ${JSON.stringify(chain)}`);
			continue;
		}
		checkFields(chain, CHAIN_FIELDS, key, problems);
		if (typeof chain.chain_id === "string" && chain.chain_id !== key) {
			problems.push(
				`${key}.chain_id: expected the key ${JSON.stringify(key)}, got ${JSON.stringify(chain.chain_id)}`,
			);
		}
		if (!Array.isArray(chain.tokens)) {
			problems.push(`${key}.tokens: expected an array, got ${JSON.stringify(chain.tokens)}`);
			continue;
		}
		chain.tokens.forEach((token, index) => {
			checkFields(token, TOKEN_FIELDS, `${key}.tokens[${index}]`, problems);
		});
	}
	return problems;
}

async function load(file) {
	if (file) return JSON.parse(await readFile(file, "utf8"));
	const response = await fetch(DEFAULTS_URL, {
		headers: { accept: "application/json", "user-agent": USER_AGENT },
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`GET ${DEFAULTS_URL} returned HTTP ${response.status}`);
	return response.json();
}

const file = process.argv[2];
const source = file ?? `GET ${DEFAULTS_URL}`;

let listing;
try {
	listing = await load(file);
} catch (error) {
	console.log(`error: ${source}: ${error.message}`);
	process.exit(1);
}

const problems = checkListing(listing);
if (problems.length > 0) {
	console.log(`drift: ${source} no longer has the shape the prober reads.`);
	for (const problem of problems) console.log(`- ${problem}`);
	process.exit(1);
}

const chains = Object.entries(listing);
const tokenCount = chains.reduce((sum, [, chain]) => sum + chain.tokens.length, 0);
console.log(
	`ok: ${source} has ${chains.length} chains and ${tokenCount} tokens in the expected shape.`,
);
for (const [key, chain] of chains) {
	console.log(`- ${key}: ${chain.tokens.map((token) => token.symbol).join(", ")}`);
}
