import { isoAt } from "../domain/brands";
import { isEmptyPlan, planNotifications, renderMessage } from "../domain/notify";
import type { WebhookSender } from "../notify/webhook";
import type { Store } from "../store/store";
import type { Config } from "./config";
import { readHealth } from "./health";

export interface CanaryDeps {
	readonly config: Config;
	readonly store: Store;
	/** Epoch ms. */
	readonly now: () => number;
	/** Null when no webhook is configured. */
	readonly sender: WebhookSender | null;
}

/**
 * Announces what changed since the last delivered announcement. It records a
 * plan only after the webhook took it, so a failed run leaves the same plan for
 * the next one. With no webhook it only logs and records nothing, so that a
 * webhook configured later announces every active alert.
 */
export async function runCanary(deps: CanaryDeps): Promise<void> {
	const { config, store, sender } = deps;
	const nowMs = deps.now();
	const { health } = await readHealth({ config, store, nowMs });
	const plan = planNotifications({
		current: health.alerts,
		announced: await store.readAnnouncedAlerts(config.network),
		minSeverity: config.alertMinSeverity,
	});
	const summary = {
		event: "canary",
		status: health.status,
		alerts: health.alerts.length,
		raised: plan.raised.length,
		cleared: plan.cleared.length,
	};
	if (isEmptyPlan(plan)) {
		console.info(summary);
		return;
	}
	const message = renderMessage({
		plan,
		network: config.network,
		generatedAt: health.checkedAt,
		publicUrl: config.publicUrl,
	});
	if (sender === null) {
		const unsent = { ...summary, webhook: null, text: message.text };
		if (plan.raised.some((alert) => alert.severity === "critical")) console.warn(unsent);
		else console.info(unsent);
		return;
	}
	const delivery = await sender.send(message);
	if (!delivery.ok) {
		console.error({
			event: "canary_delivery_failed",
			reason: delivery.reason,
			webhook: sender.origin,
			raised: plan.raised.length,
			cleared: plan.cleared.length,
		});
		return;
	}
	await store.applyAnnouncements(config.network, { ...plan, announcedAt: isoAt(nowMs) });
	console.info({ ...summary, webhook: sender.origin });
}
