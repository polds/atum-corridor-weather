import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { createGatewayClient } from "../../src/gateway/client";

const servers: Server[] = [];
afterAll(() => {
	for (const server of servers) server.close();
});

interface Answer {
	readonly status: number;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: string;
}

/** A loopback HTTP server that logs every request it receives. */
function listen(answer: (method: string, url: string) => Answer): Promise<{
	readonly origin: string;
	readonly seen: string[];
}> {
	const seen: string[] = [];
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			seen.push(`${request.method} ${request.url}`);
			const out = answer(request.method ?? "", request.url ?? "");
			response.writeHead(out.status, out.headers ?? {});
			response.end(out.body ?? "");
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

describe("gateway client over real HTTP", () => {
	it("sends one request per call when the gateway answers 307 or 302", async () => {
		const other = await listen(() => ({ status: 200, body: "{}" }));
		const gateway = await listen((method) =>
			method === "POST"
				? { status: 307, headers: { location: "/v1/payments/awards" } }
				: { status: 302, headers: { location: `${other.origin}/collect` } },
		);
		const client = createGatewayClient({
			baseUrl: gateway.origin,
			userAgent: "corridor-weather/test",
			// What src/worker/index.ts passes: the platform fetch.
			fetch: (input, init) => fetch(input, init),
			now: () => Date.now(),
			timeoutMs: 5000,
		});

		const created = await client.createQuoteRequest({ request_id: "cw1.x" } as never);
		const defaults = await client.getDefaults();

		expect(gateway.seen).toStrictEqual([
			"POST /v1/payments/quote-requests?wait=false",
			"GET /v1/defaults",
		]);
		expect(other.seen).toStrictEqual([]);
		expect(created).toMatchObject({ ok: false, failure: { kind: "http", status: 307 } });
		expect(defaults).toMatchObject({ ok: false, failure: { kind: "http", status: 302 } });
	});
});
