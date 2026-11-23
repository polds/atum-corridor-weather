import { env } from "cloudflare:workers";
import { createGatewayClient } from "../../src/gateway/client";
import { createStore, type Store } from "../../src/store/store";
import { type Config, parseConfig } from "../../src/worker/config";
import type { TickDeps } from "../../src/worker/tick";
import {
	FakeClock,
	fakeGateway,
	type Handler,
	jsonResponse,
	type Scenario,
	scriptedFetch,
} from "./fake-gateway";
import { fixtures } from "./fixtures";

/**
 * The deployed configuration with test overrides. The cadence is pinned,
 * because the tests place ticks on five-minute slots and the deployed cadence
 * is free to change: 30 probes a tick, before the subrequest cap, and a
 * publish on every tick.
 */
export function testConfig(overrides: Readonly<Record<string, string>> = {}): Config {
	const parsed = parseConfig({
		...env,
		PROBE_CRON: "*/5 * * * *",
		CANARY_CRON: "2-59/5 * * * *",
		PROBES_PER_TICK: "30",
		PUBLISH_EVERY_TICKS: "1",
		...overrides,
	});
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	return parsed.config;
}

/** Only Arbitrum Sepolia USDC to Base Sepolia USDC, at the small tier. */
export const ONE_TARGET = {
	CORRIDOR_FILTER: "^eip155:421614/USDC>eip155:84532/USDC$",
	AMOUNT_TIERS: '{"small":"1"}',
};

export function tickHarness(params: {
	readonly startMs: number;
	readonly config: Config;
	readonly scenario: Scenario;
	readonly defaults?: () => Response;
	/** Rewrites the fake gateway's answers. */
	readonly wrap?: (handler: Handler) => Handler;
}): {
	readonly deps: TickDeps;
	readonly clock: FakeClock;
	readonly store: Store;
	readonly requests: ReturnType<typeof scriptedFetch>["requests"];
} {
	const clock = new FakeClock(params.startMs);
	const gateway = fakeGateway({
		clock,
		defaults: params.defaults ?? (() => jsonResponse(200, fixtures.testnetDefaults)),
		scenario: params.scenario,
	});
	const fake = scriptedFetch(params.wrap?.(gateway) ?? gateway);
	const store = createStore(env.DB);
	return {
		deps: {
			config: params.config,
			gateway: createGatewayClient({
				baseUrl: params.config.gatewayUrl,
				userAgent: "corridor-weather/test",
				fetch: fake.fetch,
				now: clock.now,
				timeoutMs: 1000,
			}),
			store,
			now: clock.now,
			sleep: clock.sleep,
		},
		clock,
		store,
		requests: fake.requests,
	};
}

export function postedRequestIds(requests: ReturnType<typeof scriptedFetch>["requests"]): string[] {
	return requests.flatMap((request) =>
		request.method === "POST" &&
		typeof request.body === "object" &&
		request.body !== null &&
		"request_id" in request.body
			? [String(request.body.request_id)]
			: [],
	);
}
