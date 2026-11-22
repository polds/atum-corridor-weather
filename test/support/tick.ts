import { env } from "cloudflare:workers";
import { createGatewayClient } from "../../src/gateway/client";
import { createStore, type Store } from "../../src/store/store";
import { type Config, parseConfig } from "../../src/worker/config";
import type { TickDeps } from "../../src/worker/tick";
import { FakeClock, fakeGateway, jsonResponse, type Scenario, scriptedFetch } from "./fake-gateway";
import { fixtures } from "./fixtures";

/** The deployed configuration with test overrides. */
export function testConfig(overrides: Readonly<Record<string, string>> = {}): Config {
	const parsed = parseConfig({ ...env, ...overrides });
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
}): {
	readonly deps: TickDeps;
	readonly clock: FakeClock;
	readonly store: Store;
	readonly requests: ReturnType<typeof scriptedFetch>["requests"];
} {
	const clock = new FakeClock(params.startMs);
	const fake = scriptedFetch(
		fakeGateway({
			clock,
			defaults: params.defaults ?? (() => jsonResponse(200, fixtures.testnetDefaults)),
			scenario: params.scenario,
		}),
	);
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
