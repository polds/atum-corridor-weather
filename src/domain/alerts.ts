import { compareText, isoAt } from "./brands";
import type { Alert, AlertKind, SnapshotTick, TierReading } from "./snapshot";
import type { CorridorId, IsoTimestamp } from "./types";

/** The latest reading of one corridor at one configured tier. */
export interface TierLatest {
	readonly corridorId: CorridorId;
	readonly latest: TierReading;
}

/** The last quoted probe of one corridor at any configured tier. */
export interface LastQuote {
	readonly corridorId: CorridorId;
	readonly quotedAt: IsoTimestamp;
	/** The first probe of a configured tier after `quotedAt`. Null when none followed it. */
	readonly firstUnquotedAt: IsoTimestamp | null;
}

/** How long after its last quote a corridor that quotes at no tier still raises `quotes_lost`. */
export const QUOTES_LOST_WINDOW_DAYS = 7;

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
	readonly tiers: readonly TierLatest[];
	/** One per corridor that was ever quoted at a configured tier. */
	readonly lastQuotes: readonly LastQuote[];
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

/**
 * `quotes_lost`, a state of a corridor: it was quoted within the window, and the
 * latest probe of every probed configured tier is not quoted. Its `since` is the
 * first probe after the last quote, so it holds still while the alert is active.
 */
function quotesLostAlerts(input: AlertInput): Alert[] {
	const quotedNow = new Set(
		input.tiers.flatMap(({ corridorId, latest }) =>
			latest.outcome === "quoted" ? [corridorId] : [],
		),
	);
	const windowMs = QUOTES_LOST_WINDOW_DAYS * 24 * 60 * 60_000;
	return input.lastQuotes.flatMap((last): Alert[] => {
		if (quotedNow.has(last.corridorId)) return [];
		if (input.nowMs - Date.parse(last.quotedAt) > windowMs) return [];
		return [
			{
				kind: "quotes_lost",
				severity: "critical",
				corridorId: last.corridorId,
				message: `No tier is quoted now. The last quote was at ${last.quotedAt}.`,
				since: last.firstUnquotedAt ?? last.quotedAt,
			},
		];
	});
}

function slowQuoteAlert({ corridorId, latest }: TierLatest, slowQuoteMs: number): Alert[] {
	if (latest.firstQuoteMs === null || latest.firstQuoteMs <= slowQuoteMs) return [];
	return [
		{
			kind: "slow_quotes",
			severity: "warning",
			corridorId,
			message: `The ${latest.tier} tier took ${latest.firstQuoteMs} ms to its first quote, over ${slowQuoteMs} ms.`,
			since: latest.probedAt,
		},
	];
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
		...quotesLostAlerts(input),
		...input.tiers.flatMap((tier) => slowQuoteAlert(tier, input.slowQuoteMs)),
	].sort(
		(a, b) =>
			KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
			compareText(a.corridorId ?? "", b.corridorId ?? "") ||
			compareText(a.message, b.message),
	);
}
