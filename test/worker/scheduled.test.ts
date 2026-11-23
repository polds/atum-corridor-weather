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

const HOOK = "http://127.0.0.1:9999/hook";

async function runScheduled(
	overrides: Readonly<Record<string, unknown>>,
	cron = env.PROBE_CRON,
): Promise<Request[]> {
	const sent: Request[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		sent.push(request);
		const { pathname } = new URL(request.url);
		if (pathname === "/hook") return new Response("ok");
		if (pathname === "/v1/defaults") return jsonResponse(200, fixtures.testnetDefaults);
		if (request.method === "POST") return jsonResponse(202, fixtures.quoted.events[0]?.json);
		return jsonResponse(200, lastPoll);
	});
	const ctx = createExecutionContext();
	worker.scheduled(
		createScheduledController({ scheduledTime: Date.now(), cron }),
		{ ...env, GATEWAY_URL: "http://127.0.0.1:8789", ...overrides },
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return sent;
}

describe("scheduled handler", () => {
	it("runs one tick against the configured gateway and publishes", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const sent = await runScheduled(ONE_TARGET);
		expect(sent.map((request) => `${request.method} ${new URL(request.url).host}`)).toStrictEqual([
			"GET 127.0.0.1:8789",
			"POST 127.0.0.1:8789",
			"GET 127.0.0.1:8789",
		]);
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({ event: "tick", planned: 1, unrepresentable: 0 }),
		);
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
	it("runs the canary, not a tick, on the canary cron", async () => {
		vi.spyOn(console, "info").mockImplementation(() => {});
		const sent = await runScheduled({ ALERT_WEBHOOK_URL: HOOK }, env.CANARY_CRON);
		expect(sent.map((request) => `${request.method} ${request.url}`)).toStrictEqual([
			`POST ${HOOK}`,
		]);
		expect(sent[0]?.headers.get("user-agent")).toMatch(/^corridor-weather\/0\.1\.0 /);
		expect(await sent[0]?.json()).toMatchObject({ text: expect.stringContaining("prober_stale") });
		expect(await env.DB.prepare("SELECT count(*) AS n FROM ticks").first("n")).toBe(0);
	});

	it("runs a tick, not the canary, on the probe cron", async () => {
		vi.spyOn(console, "info").mockImplementation(() => {});
		const sent = await runScheduled({ ...ONE_TARGET, ALERT_WEBHOOK_URL: HOOK });
		expect(sent.some((request) => request.url === HOOK)).toBe(false);
		expect(await env.DB.prepare("SELECT count(*) AS n FROM ticks").first("n")).toBe(1);
	});

	it("does nothing on a cron that matches neither variable, and logs it", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const sent = await runScheduled({ ...ONE_TARGET, ALERT_WEBHOOK_URL: HOOK }, "0 0 * * *");
		expect(sent).toStrictEqual([]);
		expect(error).toHaveBeenCalledWith({ event: "unknown_cron", cron: "0 0 * * *" });
		expect(await env.DB.prepare("SELECT count(*) AS n FROM ticks").first("n")).toBe(0);
	});

	it.each([
		["a trailing space", `${env.CANARY_CRON} `],
		["a double space", env.CANARY_CRON.replace(" ", "  ")],
		["nonsense", "nonsense"],
	])("sends no gateway request on the canary trigger when CANARY_CRON has %s", async (_, bad) => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "info").mockImplementation(() => {});
		const sent = await runScheduled(
			{ ...ONE_TARGET, ALERT_WEBHOOK_URL: HOOK, CANARY_CRON: bad },
			env.CANARY_CRON,
		);
		expect(sent).toStrictEqual([]);
		expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: "config_invalid" }));
		expect(await env.DB.prepare("SELECT count(*) AS n FROM ticks").first("n")).toBe(0);
	});

	it("logs a canary that throws instead of rejecting", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const broken = {
			prepare: () => ({ bind: () => ({ all: () => Promise.reject(new Error("D1 down")) }) }),
		};
		const sent = await runScheduled({ DB: broken, ALERT_WEBHOOK_URL: HOOK }, env.CANARY_CRON);
		expect(sent).toStrictEqual([]);
		expect(error).toHaveBeenCalledWith({ event: "canary_failed", error: "Error: D1 down" });
	});
});
