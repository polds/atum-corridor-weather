#!/usr/bin/env node
// A local stand-in for the Atum gateway, for `wrangler dev` runs. It serves the
// testnet defaults fixture and replays the quoted fixture for every quote
// request, keyed by request_id. Any other route answers 404 and is logged.
// Usage: node test/e2e/stub-gateway.mjs [port]
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const fixture = (name) =>
	JSON.parse(readFileSync(new URL(`../fixtures/gateway/${name}`, import.meta.url), "utf8"));
const defaults = fixture("defaults.testnet.json");
const quoted = fixture("probe.quoted.json");
const port = Number(process.argv[2] ?? 8789);
const batches = new Map();

function send(response, status, body) {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

createServer((request, response) => {
	let text = "";
	request.on("data", (chunk) => {
		text += chunk;
	});
	request.on("end", () => {
		const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
		const body = text === "" ? null : JSON.parse(text);
		const log = { method: request.method, path: url.pathname, query: url.search };
		if (request.method === "GET" && url.pathname === "/v1/defaults") {
			console.log(JSON.stringify(log));
			return send(response, 200, defaults);
		}
		if (request.method === "POST" && url.pathname === "/v1/payments/quote-requests") {
			const id = `qr_${body.request_id}`;
			const replay = batches.has(id);
			batches.set(id, 1);
			console.log(
				JSON.stringify({
					...log,
					request_id: body.request_id,
					quote_selector: body.quote_selector,
					has_sender_auth: "sender_auth" in body,
					user_agent: request.headers["user-agent"],
				}),
			);
			return send(response, 202, {
				...quoted.events[0].json,
				quote_request_id: id,
				idempotent_replay: replay,
			});
		}
		const id = url.pathname.match(/^\/v1\/payments\/quote-requests\/([^/]+)$/)?.[1];
		if (request.method === "GET" && id !== undefined && batches.has(id)) {
			const next = batches.get(id);
			batches.set(id, next + 1);
			const event = quoted.events[Math.min(next, quoted.events.length - 1)];
			console.log(JSON.stringify({ ...log, status: event.json.status }));
			return send(response, 200, { ...event.json, quote_request_id: id });
		}
		console.log(JSON.stringify({ ...log, refused: true }));
		return send(response, 404, { code: "NOT_FOUND", message: "stub gateway" });
	});
}).listen(port, "127.0.0.1", () => {
	console.log(`stub gateway on http://127.0.0.1:${port}`);
});
