import { compareText, isoAt } from "./brands";
import type { Alert, AlertKind, SnapshotTick, TierReading } from "./snapshot";
import type { CorridorId, IsoTimestamp } from "./types";

/** The latest and the previous reading of one corridor at one tier. */
export interface TierHistory {
	readonly corridorId: CorridorId;
	readonly latest: TierReading;
	readonly previous: TierReading | null;
}

export interface AlertInput {
	readonly nowMs: number;
	readonly tickIntervalMinutes: number;
	readonly slowQuoteMs: number;
	readonly lastTick: SnapshotTick | null;
	/**
	 * Slot start of the first failing tick after the last healthy one, or null
	 * when the last tick is healthy. The store reads it with the rule of `tickErrored`.
	 */
	readonly errorRunStart: IsoTimestamp | null;
	readonly tiers: readonly TierHistory[];
}

const KIND_ORDER: readonly AlertKind[] = [
	"prober_stale",
	"gateway_errors",
	"quotes_lost",
	"slow_quotes",
];

/** `prober_stale`: no tick finished within three intervals of `nowMs`. */
export function staleAlert(params: {
	readonly nowMs: number;
	readonly tickIntervalMinutes: number;
	readonly lastTickFinishedAt: IsoTimestamp | null;
}): Alert | null {
	const { nowMs, tickIntervalMinutes, lastTickFinishedAt } = params;
	const limitMs = 3 * tickIntervalMinutes * 60_000;
	if (lastTickFinishedAt === null) {
		return {
			kind: "prober_stale",
			severity: "critical",
			corridorId: null,
			message: "No tick has finished yet.",
			since: isoAt(nowMs),
		};
	}
	if (nowMs - Date.parse(lastTickFinishedAt) <= limitMs) return null;
	return {
		kind: "prober_stale",
		severity: "critical",
		corridorId: null,
		message: `No tick has finished since ${lastTickFinishedAt}, more than three intervals ago.`,
		since: lastTickFinishedAt,
	};
}

/** A failing tick. `ERRORED_TICK` in `src/store/store.ts` is the same rule in SQL. */
function tickErrored(tick: SnapshotTick): boolean {
	if (tick.aborted === "defaults_unavailable") return true;
	return tick.completed > 0 && 2 * tick.gatewayErrors >= tick.completed;
}

function gatewayErrorsAlert(
	latest: SnapshotTick | null,
	errorRunStart: IsoTimestamp | null,
): Alert | null {
	if (latest === null || !tickErrored(latest)) return null;
	const message =
		latest.aborted === "defaults_unavailable"
			? "The last tick could not read /v1/defaults."
			: `${latest.gatewayErrors} of ${latest.completed} probes in the last tick were gateway errors.`;
	return {
		kind: "gateway_errors",
		severity: "critical",
		corridorId: null,
		message,
		since: errorRunStart ?? latest.slotStart,
	};
}

function tierAlerts(history: TierHistory, slowQuoteMs: number): Alert[] {
	const { corridorId, latest, previous } = history;
	const alerts: Alert[] = [];
	if (previous?.outcome === "quoted" && latest.outcome !== "quoted") {
		alerts.push({
			kind: "quotes_lost",
			severity: "critical",
			corridorId,
			message: `The ${latest.tier} tier was quoted at ${previous.probedAt} and was ${latest.outcome} at ${latest.probedAt}.`,
			since: latest.probedAt,
		});
	}
	if (latest.firstQuoteMs !== null && latest.firstQuoteMs > slowQuoteMs) {
		alerts.push({
			kind: "slow_quotes",
			severity: "warning",
			corridorId,
			message: `The ${latest.tier} tier took ${latest.firstQuoteMs} ms to its first quote, over ${slowQuoteMs} ms.`,
			since: latest.probedAt,
		});
	}
	return alerts;
}

/** Every active alert, critical kinds first, then by corridor. */
export function alertsFor(input: AlertInput): Alert[] {
	const stale = staleAlert({
		nowMs: input.nowMs,
		tickIntervalMinutes: input.tickIntervalMinutes,
		lastTickFinishedAt: input.lastTick?.finishedAt ?? null,
	});
	const errors = gatewayErrorsAlert(input.lastTick, input.errorRunStart);
	return [
		...(stale === null ? [] : [stale]),
		...(errors === null ? [] : [errors]),
		...input.tiers.flatMap((history) => tierAlerts(history, input.slowQuoteMs)),
	].sort(
		(a, b) =>
			KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
			compareText(a.corridorId ?? "", b.corridorId ?? "") ||
			compareText(a.message, b.message),
	);
}
