#!/usr/bin/env node
// A local stand-in for an alert webhook, for `wrangler dev` runs. It logs the
// method, path and body of every request and answers 200.
// Usage: node test/e2e/webhook-receiver.mjs [port]
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8790);

createServer((request, response) => {
	let text = "";
	request.on("data", (chunk) => {
		text += chunk;
	});
	request.on("end", () => {
		console.log(JSON.stringify({ method: request.method, path: request.url, body: text }));
		response.writeHead(200, { "content-type": "text/plain" });
		response.end("ok");
	});
}).listen(port, "127.0.0.1", () => {
	console.log(`webhook receiver on http://127.0.0.1:${port}`);
});
