import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createStore } from "../../src/store/store";
import { parseConfig } from "../../src/worker/config";
import { handleRequest } from "../../src/worker/routes";
import { runTick } from "../../src/worker/tick";
import { clearTables } from "../support/db";
import type { Scenario } from "../support/fake-gateway";
import { ARB_TO_BASE_USDC, fixtures, QUOTED_SETTLER } from "../support/fixtures";
import { ONE_TARGET, testConfig, tickHarness } from "../support/tick";

const INTERVAL_MS = 5 * 60_000;
const config = testConfig(ONE_TARGET);
const HISTORY = `/api/v1/corridors/${encodeURIComponent(ARB_TO_BASE_USDC)}/history.json`;

/** One tick, `ticksAgo` intervals before now, on the one configured corridor tier. */
async function tickAt(ticksAgo: number, scenario: Scenario) {
	const scheduled = Date.now() - ticksAgo * INTERVAL_MS;
	const { deps } = tickHarness({ startMs: scheduled, config, scenario });
	return runTick(deps, scheduled);
}

function get(path: string, init?: RequestInit): Promise<Response> {
	return SELF.fetch(`https://corridor-weather.test${path}`, init);
}

beforeEach(clearTables);

describe("read-only routes", () => {
	it("canary drill: a corridor tier quoted and then declined turns health to 503", async () => {
		await tickAt(2, () => fixtures.quoted);
		const healthy = await get("/api/v1/health");
		expect(healthy.status).toBe(200);
		expect(await healthy.json()).toMatchObject({ status: "ok", network: "testnet", alerts: [] });

		await tickAt(1, () => fixtures.declinedLiquidity);
		const alerting = await get("/api/v1/health");
		expect(alerting.status).toBe(503);
		expect(alerting.headers.get("cache-control")).toBe("no-store");
		const report = await alerting.json();
		expect(report).toMatchObject({
			status: "alerting",
			alerts: [{ kind: "quotes_lost", severity: "critical", corridorId: ARB_TO_BASE_USDC }],
		});

		await tickAt(0, () => fixtures.quoted);
		expect((await get("/api/v1/health")).status).toBe(200);
	});

	it("serves the stored snapshot with a one-minute public cache", async () => {
		expect((await get("/api/v1/snapshot.json")).status).toBe(404);
		await tickAt(0, () => fixtures.quoted);
		const response = await get("/api/v1/snapshot.json");
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("public, max-age=60");
		expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(response.headers.get("x-disclaimer")).toMatch(/unofficial/);
		const text = await response.text();
		expect(text).toBe(await createStore(env.DB).readSnapshotJson("testnet"));
		expect(JSON.parse(text)).toMatchObject({
			schemaVersion: 1,
			network: "testnet",
			corridors: [{ id: ARB_TO_BASE_USDC, condition: "fair" }],
		});
	});

	it("serves a corridor's history for a number of days", async () => {
		await tickAt(1, () => fixtures.quoted);
		await tickAt(0, () => fixtures.declinedInternal);
		const response = await get(HISTORY);
		expect(response.status).toBe(200);
		const history = await response.json();
		expect(history).toMatchObject({
			corridorId: ARB_TO_BASE_USDC,
			days: 7,
			points: [
				{ tier: "small", outcome: "quoted", quoteCount: 1, operatorCount: 1, bestSpreadBps: 2 },
				{
					tier: "small",
					outcome: "declined",
					declines: [{ reason: "INTERNAL", retryClassification: "RETRY_AFTER_DELAY", count: 1 }],
				},
			],
		});
		expect((await get(`${HISTORY}?days=30`)).status).toBe(200);
		expect((await get(`${HISTORY}?days=31`)).status).toBe(400);
		expect((await get(`${HISTORY}?days=0`)).status).toBe(400);
		expect((await get(`${HISTORY}?days=week`)).status).toBe(400);
	});

	it("answers 404 for an unknown corridor and an unknown API path", async () => {
		await tickAt(0, () => fixtures.quoted);
		const unknown = await get(
			`/api/v1/corridors/${encodeURIComponent("eip155:1/erc20:0xaa>eip155:2/erc20:0xbb")}/history.json`,
		);
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toStrictEqual({
			error: "unknown_corridor",
			message: "No such corridor.",
		});
		expect((await get("/api/v1/corridors/not-a-corridor/history.json")).status).toBe(404);
		expect((await get("/api/v1/corridors/%E0%A4%A/history.json")).status).toBe(404);
		const missing = await get("/api/v2/everything");
		expect(missing.status).toBe(404);
		expect(await missing.json()).toMatchObject({ error: "not_found" });
	});

	it("serves only GET and HEAD", async () => {
		const post = await get("/api/v1/snapshot.json", { method: "POST", body: "{}" });
		expect(post.status).toBe(405);
		expect(post.headers.get("allow")).toBe("GET, HEAD");
		await tickAt(0, () => fixtures.quoted);
		const head = await get("/api/v1/snapshot.json", { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");
	});

	it("exposes Prometheus metrics", async () => {
		await tickAt(0, () => fixtures.quoted);
		const response = await get("/metrics");
		expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
		const lines = (await response.text()).split("\n");
		const labels = `network="testnet",corridor="${ARB_TO_BASE_USDC}",tier="small"`;
		expect(lines).toContain(`corridor_weather_quote_count{${labels}} 1`);
		expect(lines).toContain(`corridor_weather_best_spread_bps{${labels}} 2`);
		expect(lines).toContain('corridor_weather_last_tick_completed{network="testnet"} 1');
		expect(lines).toContain(
			'corridor_weather_alert{network="testnet",kind="prober_stale",severity="critical"} 0',
		);
	});

	it("publishes no operator address in the snapshot, the history or the metrics", async () => {
		await tickAt(0, () => fixtures.quoted);
		const raw = await env.DB.prepare("SELECT raw_json FROM probe_raw").first("raw_json");
		expect(String(raw)).toContain(QUOTED_SETTLER);
		for (const path of ["/api/v1/snapshot.json", HISTORY, "/metrics", "/api/v1/health"]) {
			const body = (await (await get(path)).text()).toLowerCase();
			expect(body, path).not.toContain(QUOTED_SETTLER);
			expect(body, path).not.toContain(QUOTED_SETTLER.slice(2));
		}
	});

	const direct = (path: string, overrides: Readonly<Record<string, string>> = {}) =>
		handleRequest(new Request(`https://corridor-weather.test${path}`), {
			config: parseConfig({ ...env, ...overrides }),
			store: createStore(env.DB),
			assets: { fetch: async () => new Response("dashboard") },
			nowMs: Date.now(),
		});

	it("reports an invalid configuration instead of serving", async () => {
		const response = await direct("/api/v1/health", { NETWORK: "mainnet" });
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ error: "config_invalid" });
	});

	it("leaves every other path to the static dashboard", async () => {
		expect(await (await direct("/")).text()).toBe("dashboard");
	});
});
