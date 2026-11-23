import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebhookSender } from "../../src/notify/webhook";
import { createStore } from "../../src/store/store";
import { runCanary } from "../../src/worker/canary";
import type { Config } from "../../src/worker/config";
import worker from "../../src/worker/index";
import { runTick } from "../../src/worker/tick";
import { clearTables } from "../support/db";
import { type Handler, type Scenario, scriptedFetch } from "../support/fake-gateway";
import { ARB_TO_BASE_USDC, fixtures, QUOTED_SETTLER } from "../support/fixtures";
import { ONE_TARGET, testConfig, tickHarness } from "../support/tick";

const INTERVAL_MS = 5 * 60_000;
const HOOK = "https://hooks.example.test/services/T000/B000/secret-token";
const config = testConfig({ ...ONE_TARGET, ALERT_WEBHOOK_URL: HOOK });

beforeEach(clearTables);
afterEach(() => {
	vi.restoreAllMocks();
});

/** One tick, `ticksAgo` intervals before now, on the one configured corridor tier. */
async function tickAt(ticksAgo: number, scenario: Scenario): Promise<void> {
	const scheduled = Date.now() - ticksAgo * INTERVAL_MS;
	const { deps } = tickHarness({ startMs: scheduled, config, scenario });
	await runTick(deps, scheduled);
}

/** One canary run against a webhook that answers with `answer`. Returns the bodies it received. */
async function canary(
	answer: Handler = () => new Response("ok"),
	runConfig: Config = config,
): Promise<string[]> {
	const hook = scriptedFetch(answer);
	const sender =
		runConfig.alertWebhook === null
			? null
			: createWebhookSender({
					...runConfig.alertWebhook,
					userAgent: "corridor-weather/test",
					fetch: hook.fetch,
					timeoutMs: 1000,
				});
	await runCanary({ config: runConfig, store: createStore(env.DB), now: () => Date.now(), sender });
	expect(hook.requests.every((request) => request.url.href === HOOK)).toBe(true);
	return hook.requests.map((request) => {
		const body = request.body;
		return typeof body === "object" && body !== null && "text" in body ? String(body.text) : "";
	});
}

async function announcedKeys(): Promise<string[]> {
	return (await createStore(env.DB).readAnnouncedAlerts("testnet")).map((row) => row.key);
}

describe("canary", () => {
	it("canary drill: announces quotes_lost once when raised and once when cleared", async () => {
		vi.spyOn(console, "info").mockImplementation(() => {});
		await tickAt(2, () => fixtures.quoted);
		expect(await canary()).toStrictEqual([]);

		await tickAt(1, () => fixtures.declinedLiquidity);
		const raised = await canary();
		expect(raised).toHaveLength(1);
		const [text = ""] = raised;
		expect(text).toMatch(/^Corridor Weather on testnet\. An unofficial open-source project/);
		expect(text).toContain("Raised (1)");
		expect(text).toContain(
			`[critical] quotes_lost: ${ARB_TO_BASE_USDC}: No tier is quoted now. The last quote was at `,
		);
		expect(text).not.toContain("Cleared");
		expect(text.toLowerCase()).not.toContain(QUOTED_SETTLER.slice(2));
		expect(await announcedKeys()).toStrictEqual([`quotes_lost|${ARB_TO_BASE_USDC}`]);

		expect(await canary()).toStrictEqual([]);

		await tickAt(0, () => fixtures.quoted);
		const cleared = await canary();
		expect(cleared).toHaveLength(1);
		expect(cleared[0]).toContain(`Cleared (1)\n[critical] quotes_lost: ${ARB_TO_BASE_USDC}`);
		expect(cleared[0]).not.toContain("Raised");
		expect(await announcedKeys()).toStrictEqual([]);
		expect(await canary()).toStrictEqual([]);
	});

	it("keeps quotes_lost, health at 503 and the same since while the corridor stays unquoted", async () => {
		vi.spyOn(console, "info").mockImplementation(() => {});
		const health = async () => {
			const response = await worker.fetch(
				new Request("https://corridor-weather.test/api/v1/health"),
				env,
			);
			const body: { alerts: { kind: string; since: string }[] } = await response.json();
			return { status: response.status, lost: body.alerts.filter((a) => a.kind === "quotes_lost") };
		};
		await tickAt(3, () => fixtures.quoted);
		await tickAt(2, () => fixtures.declinedLiquidity);
		expect(await canary()).toHaveLength(1);
		const first = await health();
		expect(first.status).toBe(503);
		expect(first.lost).toHaveLength(1);

		await tickAt(1, () => fixtures.declinedLiquidity);
		expect(await canary()).toStrictEqual([]);
		expect(await health()).toStrictEqual(first);
		expect(await announcedKeys()).toStrictEqual([`quotes_lost|${ARB_TO_BASE_USDC}`]);

		await tickAt(0, () => fixtures.quoted);
		const [cleared = ""] = await canary();
		expect(cleared).toContain(`Cleared (1)\n[critical] quotes_lost: ${ARB_TO_BASE_USDC}`);
	});

	it("sends the same raised message again after a failed delivery, and only then records it", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "info").mockImplementation(() => {});
		await tickAt(2, () => fixtures.quoted);
		await tickAt(1, () => fixtures.declinedLiquidity);

		const failed = await canary(() => new Response("down", { status: 503 }));
		expect(failed).toHaveLength(1);
		expect(await announcedKeys()).toStrictEqual([]);
		expect(error).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "canary_delivery_failed",
				reason: "HTTP 503",
				webhook: "https://hooks.example.test",
			}),
		);
		expect(JSON.stringify(error.mock.calls)).not.toContain("secret-token");

		const retried = await canary();
		expect(retried).toStrictEqual(failed);
		expect(await announcedKeys()).toStrictEqual([`quotes_lost|${ARB_TO_BASE_USDC}`]);
		expect(await canary()).toStrictEqual([]);
	});

	it("announces prober_stale on a fresh deploy with no tick and no snapshot", async () => {
		vi.spyOn(console, "info").mockImplementation(() => {});
		const [text = ""] = await canary();
		expect(text).toContain("Raised (1)\n[critical] prober_stale: No tick has finished yet.");
		expect(await announcedKeys()).toStrictEqual(["prober_stale|"]);
	});

	it("only logs without a webhook, and records nothing, so a later webhook announces it", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "info").mockImplementation(() => {});
		const unhooked = testConfig(ONE_TARGET);
		expect(await canary(undefined, unhooked)).toStrictEqual([]);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "canary", status: "alerting", raised: 1, webhook: null }),
		);
		expect(await announcedKeys()).toStrictEqual([]);

		expect(await canary()).toHaveLength(1);
		expect(await announcedKeys()).toStrictEqual(["prober_stale|"]);
	});

	it("puts the webhook URL in none of the public documents", async () => {
		await tickAt(1, () => fixtures.quoted);
		await tickAt(0, () => fixtures.declinedLiquidity);
		const history = `/api/v1/corridors/${encodeURIComponent(ARB_TO_BASE_USDC)}/history.json`;
		const hooked = { ...env, ALERT_WEBHOOK_URL: HOOK };
		for (const path of ["/api/v1/snapshot.json", history, "/metrics", "/api/v1/health"]) {
			const response = await worker.fetch(
				new Request(`https://corridor-weather.test${path}`),
				hooked,
			);
			expect([200, 503], path).toContain(response.status);
			expect(await response.text(), path).not.toContain("secret-token");
		}
		const invalid = await worker.fetch(new Request("https://corridor-weather.test/api/v1/health"), {
			...env,
			ALERT_WEBHOOK_URL: "http://hooks.example.test/secret-token",
		});
		expect(invalid.status).toBe(500);
		expect(await invalid.text()).not.toContain("secret-token");
	});
});
