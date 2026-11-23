/**
 * Which alert changes the canary announces, and the message that announces them.
 * Pure: the caller passes the alerts, the announced rows and the time.
 */
import { compareText, isCorridorId } from "./brands";
import type { Alert, AlertKind, AlertSeverity } from "./snapshot";
import type { Brand, CorridorId, IsoTimestamp, Network } from "./types";

/** One alert identity, `${kind}|${corridorId ?? ""}`. Tiers of one corridor share a key. */
export type AlertKey = Brand<string, "AlertKey">;

/** A row of `alert_notifications`: announced as raised and not yet announced as cleared. */
export interface AnnouncedAlert {
	readonly key: AlertKey;
	readonly kind: AlertKind;
	readonly severity: AlertSeverity;
	readonly corridorId: CorridorId | null;
	readonly since: IsoTimestamp;
	readonly announcedAt: IsoTimestamp;
}

/** Empty on both sides means there is nothing to send. */
export interface NotificationPlan {
	readonly raised: readonly Alert[];
	readonly cleared: readonly AnnouncedAlert[];
}

export interface AlertMessage {
	readonly text: string;
	readonly json: {
		readonly source: "corridor-weather";
		readonly unofficial: true;
		readonly network: Network;
		readonly generatedAt: IsoTimestamp;
		readonly raised: readonly RaisedEntry[];
		readonly cleared: readonly AnnouncedAlert[];
		readonly text: string;
	};
}

type RaisedEntry = Pick<Alert, "kind" | "severity" | "corridorId" | "message" | "since"> & {
	readonly key: AlertKey;
};

const ALERT_KINDS: readonly AlertKind[] = [
	"prober_stale",
	"gateway_errors",
	"quotes_lost",
	"slow_quotes",
];

const SEVERITY_RANK: Readonly<Record<AlertSeverity, number>> = { warning: 0, critical: 1 };

/** The most lines one section of the text lists before "and N more". */
export const MAX_SECTION_LINES = 10;

export function isAlertKey(value: string): value is AlertKey {
	const split = value.indexOf("|");
	if (split < 0) return false;
	const kind = value.slice(0, split);
	const corridor = value.slice(split + 1);
	return ALERT_KINDS.some((known) => known === kind) && (corridor === "" || isCorridorId(corridor));
}

export function alertKeyOf(alert: Pick<Alert, "kind" | "corridorId">): AlertKey {
	const key = `${alert.kind}|${alert.corridorId ?? ""}`;
	if (!isAlertKey(key)) throw new Error(`alert key ${key} does not parse`);
	return key;
}

type Ordered = Pick<Alert, "kind" | "severity" | "corridorId" | "since">;

/** Critical before warning, then by `since`, then by key. */
function byPriority(a: Ordered, b: Ordered): number {
	return (
		SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
		compareText(a.since, b.since) ||
		compareText(alertKeyOf(a), alertKeyOf(b))
	);
}

/**
 * `raised`: alerts at or above `minSeverity` not yet announced, one per key.
 * `cleared`: announced alerts whose key no current alert has, whatever its
 * severity, so raising `minSeverity` never announces an active alert as cleared.
 */
export function planNotifications(params: {
	readonly current: readonly Alert[];
	readonly announced: readonly AnnouncedAlert[];
	readonly minSeverity: AlertSeverity;
}): NotificationPlan {
	const min = SEVERITY_RANK[params.minSeverity];
	const active = new Set(params.current.map(alertKeyOf));
	const announced = new Set(params.announced.map((alert) => alert.key));
	const raised = new Map<AlertKey, Alert>();
	for (const alert of [...params.current].sort(byPriority)) {
		const key = alertKeyOf(alert);
		if (SEVERITY_RANK[alert.severity] >= min && !announced.has(key) && !raised.has(key)) {
			raised.set(key, alert);
		}
	}
	return {
		raised: [...raised.values()],
		cleared: params.announced.filter((alert) => !active.has(alert.key)).sort(byPriority),
	};
}

export function isEmptyPlan(plan: NotificationPlan): boolean {
	return plan.raised.length === 0 && plan.cleared.length === 0;
}

/** A section of at most `MAX_SECTION_LINES` lines. A cut section ends with `tail`, which names how many lines it left out. */
function section(
	title: string,
	lines: readonly string[],
	tail: (more: number) => string,
): string[] {
	if (lines.length === 0) return [];
	const more = lines.length - MAX_SECTION_LINES;
	return [
		`${title} (${lines.length})`,
		...lines.slice(0, MAX_SECTION_LINES),
		...(more > 0 ? [tail(more)] : []),
	];
}

/** One message for the whole plan. It names no operator: alerts carry none. */
export function renderMessage(params: {
	readonly plan: NotificationPlan;
	readonly network: Network;
	readonly generatedAt: IsoTimestamp;
	/** Origin plus path, no trailing slash. Null leaves the links out. */
	readonly publicUrl: string | null;
}): AlertMessage {
	const { plan, network, publicUrl } = params;
	// The health report lists every active alert, so it holds the raised alerts
	// a cut section left out. It holds no cleared alert.
	const health =
		publicUrl === null
			? "listed in the health report at /api/v1/health"
			: `listed at ${publicUrl}/api/v1/health`;
	const text = [
		`Corridor Weather on ${network}. An unofficial open-source project, not an Atum product.`,
		...section(
			"Raised",
			plan.raised.map(
				(alert) =>
					`[${alert.severity}] ${alert.kind}: ${alert.corridorId === null ? "" : `${alert.corridorId}: `}${alert.message} (since ${alert.since})`,
			),
			(more) => `and ${more} more, ${health}`,
		),
		...section(
			"Cleared",
			plan.cleared.map(
				(alert) =>
					`[${alert.severity}] ${alert.kind}: ${alert.corridorId ?? "network-wide"} (since ${alert.since})`,
			),
			(more) => `and ${more} more`,
		),
		...(publicUrl === null
			? []
			: [`Dashboard: ${publicUrl}/`, `Health: ${publicUrl}/api/v1/health`]),
	].join("\n");
	return {
		text,
		json: {
			source: "corridor-weather",
			unofficial: true,
			network,
			generatedAt: params.generatedAt,
			raised: plan.raised.map((alert) => ({
				key: alertKeyOf(alert),
				kind: alert.kind,
				severity: alert.severity,
				corridorId: alert.corridorId,
				message: alert.message,
				since: alert.since,
			})),
			cleared: plan.cleared.map((alert) => ({
				key: alert.key,
				kind: alert.kind,
				severity: alert.severity,
				corridorId: alert.corridorId,
				since: alert.since,
				announcedAt: alert.announcedAt,
			})),
			text,
		},
	};
}
