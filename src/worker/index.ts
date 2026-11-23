import { version } from "../../package.json";
import { createGatewayClient, userAgent } from "../gateway/client";
import { createWebhookSender } from "../notify/webhook";
import { createStore } from "../store/store";
import { runCanary } from "./canary";
import { type Config, parseConfig } from "./config";
import { handleRequest } from "./routes";
import { runTick } from "./tick";

/** Per-call budget for one gateway request or one webhook post. A poll answers in well under a second. */
const REQUEST_TIMEOUT_MS = 10_000;

async function tick(config: Config, env: Env, scheduledTimeMs: number): Promise<void> {
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
	// A platform refusal means the plan does not fit the plan's limits: a fault to fix, not weather.
	const log = record.aborted?.reason === "subrequest_limit" ? console.error : console.info;
	log({
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

async function canary(config: Config, env: Env): Promise<void> {
	const webhook = config.alertWebhook;
	return runCanary({
		config,
		store: createStore(env.DB),
		now: () => Date.now(),
		sender:
			webhook === null
				? null
				: createWebhookSender({
						url: webhook.url,
						format: webhook.format,
						userAgent: userAgent(version, config.repositoryUrl),
						fetch: (input, init) => fetch(input, init),
						timeoutMs: REQUEST_TIMEOUT_MS,
					}),
	});
}

/**
 * The probe cron runs a tick and the canary cron announces alert changes. Any
 * other cron does nothing, so a mistyped variable cannot add probe traffic.
 * Never rejects.
 */
async function scheduled(controller: ScheduledController, env: Env): Promise<void> {
	const parsed = parseConfig(env);
	if (!parsed.ok) {
		console.error({ event: "config_invalid", errors: parsed.errors });
		return;
	}
	const { config } = parsed;
	switch (controller.cron) {
		case config.probeCron:
			await tick(config, env, controller.scheduledTime).catch((error: unknown) => {
				console.error({ event: "tick_failed", error: String(error) });
			});
			return;
		case config.canaryCron:
			await canary(config, env).catch((error: unknown) => {
				console.error({ event: "canary_failed", error: String(error) });
			});
			return;
		default:
			console.error({ event: "unknown_cron", cron: controller.cron });
	}
}

export default {
	// Cloudflare waits up to 15 minutes for the promise a Cron Trigger returns.
	// waitUntil would add nothing, and ends 30 seconds after an HTTP response.
	async scheduled(controller, env) {
		await scheduled(controller, env);
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
