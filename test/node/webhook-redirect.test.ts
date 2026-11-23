import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { isoAt } from "../../src/domain/brands";
import { renderMessage } from "../../src/domain/notify";
import { createWebhookSender } from "../../src/notify/webhook";

const servers: Server[] = [];
afterAll(() => {
	for (const server of servers) server.close();
});

/** A loopback HTTP server that logs every request and answers with `status` and `location`. */
function listen(
	status: number,
	location?: string,
): Promise<{ readonly origin: string; readonly seen: string[] }> {
	const seen: string[] = [];
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			seen.push(`${request.method} ${request.url}`);
			response.writeHead(status, location === undefined ? {} : { location });
			response.end();
		});
	});
	servers.push(server);
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({ origin: `http://127.0.0.1:${port}`, seen });
		});
	});
}

describe("webhook sender over real HTTP", () => {
	it("sends one request when the webhook answers 307", async () => {
		const other = await listen(200);
		const hook = await listen(307, `${other.origin}/collect`);
		const webhook = createWebhookSender({
			url: `${hook.origin}/hook`,
			format: "slack",
			userAgent: "corridor-weather/test",
			// What src/worker/index.ts passes: the platform fetch.
			fetch: (input, init) => fetch(input, init),
			timeoutMs: 5000,
		});
		const message = renderMessage({
			plan: { raised: [], cleared: [] },
			network: "testnet",
			generatedAt: isoAt(Date.now()),
			publicUrl: null,
		});
		const result = await webhook.send(message);
		expect(result).toStrictEqual({ ok: false, reason: "HTTP 307: redirect not followed" });
		expect(hook.seen).toStrictEqual(["POST /hook"]);
		expect(other.seen).toStrictEqual([]);
	});
});
