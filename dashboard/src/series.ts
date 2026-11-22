/**
 * Chart data derived from a corridor's history. Pure: no DOM, no clock.
 */
import type { CorridorConditions, HistoryPoint } from "../../src/domain/snapshot";
import type { AmountTier, ProbeOutcomeKind } from "../../src/domain/types";

export interface SeriesPoint {
	readonly t: number;
	/** Null draws a gap. */
	readonly v: number | null;
	readonly point: HistoryPoint;
}

export interface TierSeries {
	readonly tier: AmountTier;
	readonly points: readonly SeriesPoint[];
}

function byTier(
	tiers: readonly AmountTier[],
	points: readonly HistoryPoint[],
	value: (p: HistoryPoint) => number | null,
): readonly TierSeries[] {
	return tiers.map((tier) => ({
		tier,
		points: points
			.filter((p) => p.tier === tier)
			.map((p) => ({ t: Date.parse(p.probedAt), v: value(p), point: p }))
			.sort((a, b) => a.t - b.t),
	}));
}

/** Best spread per tier. A probe that was not quoted, or quoted across pegs, is a gap. */
export function spreadSeries(
	tiers: readonly AmountTier[],
	points: readonly HistoryPoint[],
): readonly TierSeries[] {
	return byTier(tiers, points, (p) => (p.outcome === "quoted" ? p.bestSpreadBps : null));
}

/**
 * Operators that quoted, per tier. Any outcome other than `quoted` counts as
 * zero, which is how a quotes-lost event shows: the line drops to the floor.
 */
export function operatorSeries(
	tiers: readonly AmountTier[],
	points: readonly HistoryPoint[],
): readonly TierSeries[] {
	return byTier(tiers, points, (p) => (p.outcome === "quoted" ? p.operatorCount : 0));
}

export const RETRY_AFTER_DELAY = "RETRY_AFTER_DELAY";

export interface DeclineBucket {
	readonly start: number;
	readonly end: number;
	/** Declines classified `RETRY_AFTER_DELAY`: a later retry could change them. */
	readonly retryable: number;
	/** Every other classification, including none. */
	readonly other: number;
}

export function declineBuckets(input: {
	readonly points: readonly HistoryPoint[];
	readonly start: number;
	readonly end: number;
	readonly bucketMs: number;
}): readonly DeclineBucket[] {
	const count = Math.max(1, Math.ceil((input.end - input.start) / input.bucketMs));
	const buckets = Array.from({ length: count }, (_, i) => ({
		start: input.start + i * input.bucketMs,
		end: Math.min(input.end, input.start + (i + 1) * input.bucketMs),
		retryable: 0,
		other: 0,
	}));
	for (const p of input.points) {
		const i = Math.floor((Date.parse(p.probedAt) - input.start) / input.bucketMs);
		const bucket = buckets[i];
		if (bucket === undefined) continue;
		for (const d of p.declines) {
			if (d.retryClassification === RETRY_AFTER_DELAY) bucket.retryable += d.count;
			else bucket.other += d.count;
		}
	}
	return buckets;
}

export interface DeclineReasonRow {
	readonly reason: string;
	readonly retryClassification: string | null;
	readonly count: number;
	readonly lastSeen: number;
}

/** Decline reasons over the window, most frequent first. */
export function declineReasons(points: readonly HistoryPoint[]): readonly DeclineReasonRow[] {
	const rows = new Map<
		string,
		{ reason: string; retryClassification: string | null; count: number; lastSeen: number }
	>();
	for (const p of points) {
		const t = Date.parse(p.probedAt);
		for (const d of p.declines) {
			const key = `${d.reason}\n${d.retryClassification ?? ""}`;
			const row = rows.get(key);
			if (row === undefined)
				rows.set(key, {
					reason: d.reason,
					retryClassification: d.retryClassification,
					count: d.count,
					lastSeen: t,
				});
			else {
				row.count += d.count;
				row.lastSeen = Math.max(row.lastSeen, t);
			}
		}
	}
	return [...rows.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

export type OutcomeTally = Readonly<Record<ProbeOutcomeKind, number>>;

/** Probe outcomes per tier over the window. */
export function outcomeTallies(
	tiers: readonly AmountTier[],
	points: readonly HistoryPoint[],
): ReadonlyMap<AmountTier, OutcomeTally> {
	const tallies = new Map<AmountTier, Record<ProbeOutcomeKind, number>>();
	for (const tier of tiers) {
		tallies.set(tier, { quoted: 0, declined: 0, silent: 0, incomplete: 0, gateway_error: 0 });
	}
	for (const p of points) {
		const tally = tallies.get(p.tier);
		if (tally !== undefined) tally[p.outcome] += 1;
	}
	return tallies;
}

export interface TierPrice {
	readonly tier: AmountTier;
	/** Destination-token atomic amount of the latest probe, when the tier was probed. */
	readonly fulfillmentAmount: string | null;
	readonly latestBps: number | null;
	/** Lowest and highest best spread over the history window. */
	readonly range: { readonly min: number; readonly max: number } | null;
}

/** Best spread per amount tier: the latest reading, with the window's range behind it. */
export function priceBySize(
	tiers: readonly AmountTier[],
	corridor: CorridorConditions,
	points: readonly HistoryPoint[],
): readonly TierPrice[] {
	return tiers.map((tier) => {
		const latest = corridor.tiers.find((t) => t.tier === tier);
		const spreads = points
			.filter((p) => p.tier === tier && p.outcome === "quoted" && p.bestSpreadBps !== null)
			.map((p) => p.bestSpreadBps)
			.filter((v): v is number => v !== null);
		return {
			tier,
			fulfillmentAmount:
				latest?.fulfillmentAmount ?? points.find((p) => p.tier === tier)?.fulfillmentAmount ?? null,
			latestBps: latest?.outcome === "quoted" ? latest.bestSpreadBps : null,
			range: spreads.length === 0 ? null : { min: Math.min(...spreads), max: Math.max(...spreads) },
		};
	});
}

/** Round tick values covering [min, max], about `count` of them. */
export function niceTicks(min: number, max: number, count: number): readonly number[] {
	if (!(Number.isFinite(min) && Number.isFinite(max))) return [0];
	if (max === min)
		return niceTicks(
			min === 0 ? 0 : Math.min(0, min),
			max === 0 ? 1 : Math.max(0, max) * 1.2 || 1,
			count,
		);
	const rough = (max - min) / Math.max(1, count);
	const magnitude = 10 ** Math.floor(Math.log10(rough));
	const residual = rough / magnitude;
	const step = (residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1) * magnitude;
	const first = Math.floor(min / step) * step;
	const ticks: number[] = [];
	for (let v = first; v <= max + step * 0.5; v += step) ticks.push(Math.round(v / step) * step);
	return ticks;
}

const DAY_MS = 86_400_000;

/** UTC midnights inside [start, end]. */
export function dayTicks(start: number, end: number): readonly number[] {
	const ticks: number[] = [];
	for (let t = Math.ceil(start / DAY_MS) * DAY_MS; t <= end; t += DAY_MS) ticks.push(t);
	return ticks;
}

/** The last point at or before `t`, the reading that held at that moment. */
export function readingAt(points: readonly SeriesPoint[], t: number): SeriesPoint | undefined {
	let found: SeriesPoint | undefined;
	for (const p of points) {
		if (p.t > t) break;
		found = p;
	}
	return found;
}
