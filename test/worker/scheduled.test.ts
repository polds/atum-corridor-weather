import {
	createExecutionContext,
	createScheduledController,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { clearTables } from "../support/db";
import { jsonResponse } from "../support/fake-gateway";
import { fixtures } from "../support/fixtures";
import { ONE_TARGET } from "../support/tick";

const lastPoll = fixtures.quoted.events.at(-1)?.json;

beforeEach(clearTables);
afterEach(() => {
	vi.restoreAllMocks();
});

async function runScheduled(overrides: Readonly<Record<string, string>>): Promise<Request[]> {
	const sent: Request[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		sent.push(request);
		const { pathname } = new URL(request.url);
		if (pathname === "/v1/defaults") return jsonResponse(200, fixtures.testnetDefaults);
		if (request.method === "POST") return jsonResponse(202, fixtures.quoted.events[0]?.json);
		return jsonResponse(200, lastPoll);
	});
	const ctx = createExecutionContext();
	worker.scheduled(
		createScheduledController({ scheduledTime: Date.now(), cron: "*/5 * * * *" }),
		{ ...env, GATEWAY_URL: "https://gateway.test", ...overrides },
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return sent;
}

describe("scheduled handler", () => {
	it("runs one tick against the configured gateway and publishes", async () => {
		const sent = await runScheduled(ONE_TARGET);
		expect(sent.map((request) => `${request.method} ${new URL(request.url).host}`)).toStrictEqual([
			"GET gateway.test",
			"POST gateway.test",
			"GET gateway.test",
		]);
		expect(sent[1]?.headers.get("user-agent")).toBe(
			"corridor-weather/0.1.0 (+https://github.com/polds/atum-corridor-weather; synthetic probe)",
		);
		const snapshot = await env.DB.prepare("SELECT count(*) AS n FROM snapshots").first("n");
		expect(snapshot).toBe(1);
	});

	it("sends nothing when the configuration is invalid", async () => {
		const sent = await runScheduled({ NETWORK: "mainnet" });
		expect(sent).toStrictEqual([]);
		expect(await env.DB.prepare("SELECT count(*) AS n FROM ticks").first("n")).toBe(0);
	});
});
