import { version } from "../../package.json";
import { createGatewayClient, userAgent } from "../gateway/client";
import { createStore } from "../store/store";
import { parseConfig } from "./config";
import { handleRequest } from "./routes";
import { runTick } from "./tick";

/** Per-call budget for one gateway request. A poll answers in well under a second. */
const REQUEST_TIMEOUT_MS = 10_000;

async function tick(env: Env, scheduledTimeMs: number): Promise<void> {
	const parsed = parseConfig(env);
	if (!parsed.ok) {
		console.error({ event: "config_invalid", errors: parsed.errors });
		return;
	}
	const { config } = parsed;
	const record = await runTick(
		{
			config,
			gateway: createGatewayClient({
				baseUrl: config.gatewayUrl,
				userAgent: userAgent(version, config.repositoryUrl),
				fetch: (input, init) => fetch(input, init),
				now: () => Date.now(),
				timeoutMs: REQUEST_TIMEOUT_MS,
			}),
			store: createStore(env.DB),
			now: () => Date.now(),
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		},
		scheduledTimeMs,
	);
	console.info({
		event: "tick",
		slot: record.slot.start,
		corridors: record.corridors.length,
		planned: record.planned,
		unrepresentable: record.unrepresentable,
		completed: record.probes.length,
		outcomes: record.probes.map((probe) => probe.outcome.kind),
		aborted: record.aborted,
	});
}

export default {
	scheduled(controller, env, ctx) {
		ctx.waitUntil(
			tick(env, controller.scheduledTime).catch((error: unknown) => {
				console.error({ event: "tick_failed", error: String(error) });
			}),
		);
	},
	fetch(request, env) {
		return handleRequest(request, {
			config: parseConfig(env),
			store: createStore(env.DB),
			assets: env.ASSETS,
			nowMs: Date.now(),
		});
	},
} satisfies ExportedHandler<Env>;
