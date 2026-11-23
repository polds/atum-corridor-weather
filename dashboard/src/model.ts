/**
 * The dashboard's read model: boundary parsing of the two JSON documents,
 * indexes over the snapshot, filtering and routing. Pure: no DOM, no clock.
 */
import type {
	Alert,
	Condition,
	CorridorConditions,
	CorridorHistory,
	DailyDecline,
	DailyFigures,
	DailyRange,
	HistoryPoint,
	Snapshot,
	SnapshotAsset,
	SnapshotDecline,
	TierReading,
} from "../../src/domain/snapshot";
import type { AmountTier, ProbeOutcomeKind } from "../../src/domain/types";

// ---------------------------------------------------------------------------
// Boundary parsing

export type Parsed<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: string };

type Guard<T> = (v: unknown) => v is T;

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isCount = (v: unknown): v is number => isNumber(v) && Number.isInteger(v) && v >= 0;
const isTimestamp = (v: unknown): v is string => isString(v) && !Number.isNaN(Date.parse(v));
const isAtomic = (v: unknown): v is string => isString(v) && /^\d+$/.test(v);
const orNull =
	<T>(guard: Guard<T>): Guard<T | null> =>
	(v: unknown): v is T | null =>
		v === null || guard(v);
const arrayOf =
	<T>(guard: Guard<T>): Guard<readonly T[]> =>
	(v: unknown): v is readonly T[] =>
		Array.isArray(v) && v.every(guard);
const oneOf =
	<T extends string>(values: readonly T[]): Guard<T> =>
	(v: unknown): v is T =>
		values.some((value) => value === v);

export const CONDITIONS = [
	"fair",
	"cloudy",
	"stormy",
	"unknown",
] as const satisfies readonly Condition[];
/** Every tier a reading can name, in display order. `Snapshot.tiers` holds the configured ones. */
export const TIERS = ["small", "typical", "large"] as const satisfies readonly AmountTier[];
export const OUTCOMES = [
	"quoted",
	"declined",
	"silent",
	"incomplete",
	"gateway_error",
] as const satisfies readonly ProbeOutcomeKind[];

const isNetwork = oneOf(["testnet", "mainnet"] as const);
const isCondition = oneOf(CONDITIONS);
const isTier = oneOf(TIERS);
const isOutcome = oneOf(OUTCOMES);

const isDecline = (v: unknown): v is SnapshotDecline =>
	isRecord(v) && isString(v.reason) && orNull(isString)(v.retryClassification) && isCount(v.count);

const isTierReading = (v: unknown): v is TierReading =>
	isRecord(v) &&
	isTier(v.tier) &&
	isAtomic(v.fulfillmentAmount) &&
	isTimestamp(v.probedAt) &&
	isOutcome(v.outcome) &&
	isCount(v.quoteCount) &&
	isCount(v.operatorCount) &&
	orNull(isAtomic)(v.bestSourceAmount) &&
	orNull(isNumber)(v.bestSpreadBps) &&
	orNull(isNumber)(v.worstSpreadBps) &&
	orNull(isNumber)(v.firstQuoteMs) &&
	orNull(isNumber)(v.readyMs) &&
	orNull(isNumber)(v.minPriceHoldMs) &&
	arrayOf(isDecline)(v.declines);

const isAsset = (v: unknown): v is SnapshotAsset =>
	isRecord(v) &&
	isString(v.id) &&
	isString(v.chainId) &&
	isString(v.chainLabel) &&
	isString(v.symbol) &&
	isCount(v.decimals);

const isCorridor = (v: unknown): v is CorridorConditions =>
	isRecord(v) &&
	isString(v.id) &&
	isString(v.source) &&
	isString(v.destination) &&
	isCondition(v.condition) &&
	orNull(isTimestamp)(v.lastProbedAt) &&
	arrayOf(isTierReading)(v.tiers);

const isAlert = (v: unknown): v is Alert =>
	isRecord(v) &&
	oneOf(["prober_stale", "gateway_errors", "quotes_lost", "slow_quotes"] as const)(v.kind) &&
	oneOf(["warning", "critical"] as const)(v.severity) &&
	orNull(isString)(v.corridorId) &&
	isString(v.message) &&
	isTimestamp(v.since);

const isTick = (v: unknown): v is NonNullable<Snapshot["lastTick"]> =>
	isRecord(v) &&
	isTimestamp(v.slotStart) &&
	isTimestamp(v.finishedAt) &&
	isCount(v.planned) &&
	isCount(v.completed) &&
	isCount(v.gatewayErrors) &&
	orNull(isString)(v.aborted);

const isHistoryPoint = (v: unknown): v is HistoryPoint =>
	isRecord(v) &&
	isTimestamp(v.probedAt) &&
	isTier(v.tier) &&
	isAtomic(v.fulfillmentAmount) &&
	isOutcome(v.outcome) &&
	isCount(v.quoteCount) &&
	isCount(v.operatorCount) &&
	orNull(isNumber)(v.bestSpreadBps) &&
	orNull(isNumber)(v.firstQuoteMs) &&
	arrayOf(isDecline)(v.declines);

function schemaMismatch(v: unknown): string | null {
	if (!isRecord(v)) return "the response is not a JSON object";
	if (v.schemaVersion !== 1) return `schema version ${String(v.schemaVersion)} is not supported`;
	return null;
}

/**
 * A snapshot published before `publishIntervalMinutes` existed lacks it. Such a
 * snapshot was published on every tick, so its publish interval is the tick interval.
 */
type SnapshotDocument = Omit<Snapshot, "publishIntervalMinutes"> & {
	readonly publishIntervalMinutes?: number;
};

export function parseSnapshot(json: unknown): Parsed<Snapshot> {
	const mismatch = schemaMismatch(json);
	if (mismatch !== null) return { ok: false, reason: mismatch };
	if (isSnapshotDocument(json)) {
		return {
			ok: true,
			value: {
				...json,
				publishIntervalMinutes: json.publishIntervalMinutes ?? json.tickIntervalMinutes,
			},
		};
	}
	return { ok: false, reason: "the snapshot does not have the expected shape" };
}

const isInterval = (v: unknown): v is number => isNumber(v) && v > 0;

function isSnapshotDocument(v: unknown): v is SnapshotDocument {
	return (
		isRecord(v) &&
		v.schemaVersion === 1 &&
		isNetwork(v.network) &&
		isTimestamp(v.generatedAt) &&
		isInterval(v.tickIntervalMinutes) &&
		(v.publishIntervalMinutes === undefined || isInterval(v.publishIntervalMinutes)) &&
		isRecord(v.cadence) &&
		isCount(v.cadence.probesPerTick) &&
		isNumber(v.cadence.sweepHours) &&
		arrayOf(isTier)(v.tiers) &&
		orNull(isTick)(v.lastTick) &&
		arrayOf(isAsset)(v.assets) &&
		arrayOf(isCorridor)(v.corridors) &&
		arrayOf(isAlert)(v.alerts)
	);
}

/** A history published before daily figures existed has no `daily`; it reads as none. */
export function parseHistory(json: unknown): Parsed<CorridorHistory> {
	const mismatch = schemaMismatch(json);
	if (mismatch !== null) return { ok: false, reason: mismatch };
	const document = isRecord(json) && json.daily === undefined ? { ...json, daily: [] } : json;
	if (isHistoryDocument(document)) return { ok: true, value: document };
	return { ok: false, reason: "the history does not have the expected shape" };
}

const isDailyRange = (v: unknown): v is DailyRange =>
	isRecord(v) && isNumber(v.min) && isNumber(v.mean) && isNumber(v.max);

const isOutcomeCounts = (v: unknown): v is DailyFigures["outcomes"] =>
	isRecord(v) && OUTCOMES.every((outcome) => isCount(v[outcome]));

const isDailyDecline = (v: unknown): v is DailyDecline =>
	isRecord(v) && isString(v.reason) && isCount(v.count);

const isDailyFigures = (v: unknown): v is DailyFigures =>
	isRecord(v) &&
	isString(v.day) &&
	isTier(v.tier) &&
	isCount(v.probes) &&
	isOutcomeCounts(v.outcomes) &&
	orNull(isDailyRange)(v.bestSpreadBps) &&
	isCount(v.maxOperatorCount) &&
	orNull(isDailyRange)(v.firstQuoteMs) &&
	arrayOf(isDailyDecline)(v.declines);

function isHistoryDocument(v: unknown): v is CorridorHistory {
	return (
		isRecord(v) &&
		v.schemaVersion === 1 &&
		isNetwork(v.network) &&
		isString(v.corridorId) &&
		isTimestamp(v.generatedAt) &&
		isNumber(v.days) &&
		arrayOf(isHistoryPoint)(v.points) &&
		arrayOf(isDailyFigures)(v.daily)
	);
}

// ---------------------------------------------------------------------------
// Indexes

export interface ChainGroup {
	readonly chainId: string;
	readonly chainLabel: string;
	readonly assets: readonly SnapshotAsset[];
}

const byText = (a: string, b: string): number =>
	a.localeCompare(b, "en", { sensitivity: "base", numeric: true });

/** Chains sorted by label, assets within a chain sorted by symbol. */
export function groupAssetsByChain(assets: readonly SnapshotAsset[]): readonly ChainGroup[] {
	const groups = new Map<string, { chainLabel: string; assets: SnapshotAsset[] }>();
	for (const asset of assets) {
		const group = groups.get(asset.chainId);
		if (group === undefined)
			groups.set(asset.chainId, { chainLabel: asset.chainLabel, assets: [asset] });
		else group.assets.push(asset);
	}
	return [...groups.entries()]
		.map(([chainId, g]) => ({
			chainId,
			chainLabel: g.chainLabel,
			assets: g.assets.sort((a, b) => byText(a.symbol, b.symbol) || byText(a.id, b.id)),
		}))
		.sort((a, b) => byText(a.chainLabel, b.chainLabel) || byText(a.chainId, b.chainId));
}

export interface Board {
	readonly snapshot: Snapshot;
	readonly chains: readonly ChainGroup[];
	/** Assets in display order: chain, then symbol. */
	readonly orderedAssets: readonly SnapshotAsset[];
	readonly assetsById: ReadonlyMap<string, SnapshotAsset>;
	readonly corridorsById: ReadonlyMap<string, CorridorConditions>;
	readonly corridorAt: (source: string, destination: string) => CorridorConditions | undefined;
}

export function buildBoard(snapshot: Snapshot): Board {
	const chains = groupAssetsByChain(snapshot.assets);
	const byPair = new Map<string, CorridorConditions>();
	const corridorsById = new Map<string, CorridorConditions>();
	for (const c of snapshot.corridors) {
		byPair.set(`${c.source}\n${c.destination}`, c);
		corridorsById.set(c.id, c);
	}
	return {
		snapshot,
		chains,
		orderedAssets: chains.flatMap((g) => g.assets),
		assetsById: new Map(snapshot.assets.map((a) => [a.id, a])),
		corridorsById,
		corridorAt: (source, destination) => byPair.get(`${source}\n${destination}`),
	};
}

export function assetName(asset: SnapshotAsset | undefined, fallbackId: string): string {
	return asset === undefined ? fallbackId : `${asset.symbol} on ${asset.chainLabel}`;
}

// ---------------------------------------------------------------------------
// Corridor summary

export interface CorridorSummary {
	/** Lowest best spread among the latest tier readings that carry one. */
	readonly bestSpreadBps: number | null;
	/** Most operators that quoted any one tier in its latest reading. */
	readonly operatorCount: number;
	readonly quotedTiers: number;
	readonly probedTiers: number;
	/** Quoted, but no tier has a spread: the tokens do not share a peg. */
	readonly spreadUndefined: boolean;
}

export function summarizeCorridor(c: CorridorConditions): CorridorSummary {
	let best: number | null = null;
	let operators = 0;
	let quoted = 0;
	for (const t of c.tiers) {
		if (t.outcome === "quoted") quoted += 1;
		operators = Math.max(operators, t.operatorCount);
		if (t.bestSpreadBps !== null && (best === null || t.bestSpreadBps < best))
			best = t.bestSpreadBps;
	}
	return {
		bestSpreadBps: best,
		operatorCount: operators,
		quotedTiers: quoted,
		probedTiers: c.tiers.length,
		spreadUndefined: quoted > 0 && best === null,
	};
}

/** Tier readings in tier order, so "small, typical, large" always reads the same way. */
export function tiersInOrder(c: CorridorConditions): readonly TierReading[] {
	return [...c.tiers].sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier));
}

export const CONDITION_TEXT: Readonly<Record<Condition, { label: string; rule: string }>> = {
	fair: { label: "Fair", rule: "every probed tier was quoted" },
	cloudy: { label: "Cloudy", rule: "some tiers were quoted, some were not" },
	stormy: { label: "Stormy", rule: "no tier was quoted" },
	unknown: { label: "Unknown", rule: "not probed yet" },
};

export const OUTCOME_TEXT: Readonly<Record<ProbeOutcomeKind, { label: string; meaning: string }>> =
	{
		quoted: { label: "Quoted", meaning: "At least one operator returned a quote." },
		declined: { label: "Declined", meaning: "Operators answered with a decline and no quote." },
		silent: { label: "Silent", meaning: "Operators were asked and none answered in the window." },
		incomplete: {
			label: "Incomplete",
			meaning: "The quote window never closed before the probe gave up.",
		},
		gateway_error: {
			label: "Gateway error",
			meaning: "The gateway failed, so no operator was reached.",
		},
	};

export function conditionCounts(
	corridors: readonly CorridorConditions[],
): Readonly<Record<Condition, number>> {
	const counts: Record<Condition, number> = { fair: 0, cloudy: 0, stormy: 0, unknown: 0 };
	for (const c of corridors) counts[c.condition] += 1;
	return counts;
}

// ---------------------------------------------------------------------------
// Filtering

export interface Filter {
	/** Free text. Every word must match the source or destination chain or symbol. */
	readonly text: string;
	/** Empty means every condition. */
	readonly conditions: ReadonlySet<Condition>;
}

function assetHaystack(asset: SnapshotAsset | undefined): string {
	return asset === undefined
		? ""
		: `${asset.symbol} ${asset.chainLabel} ${asset.chainId}`.toLowerCase();
}

export function filterWords(text: string): readonly string[] {
	return text
		.toLowerCase()
		.split(/\s+/)
		.filter((w) => w !== "");
}

export function matchesFilter(
	c: CorridorConditions,
	assetsById: ReadonlyMap<string, SnapshotAsset>,
	filter: Filter,
): boolean {
	if (filter.conditions.size > 0 && !filter.conditions.has(c.condition)) return false;
	const words = filterWords(filter.text);
	if (words.length === 0) return true;
	const haystack = `${assetHaystack(assetsById.get(c.source))} ${assetHaystack(assetsById.get(c.destination))}`;
	return words.every((w) => haystack.includes(w));
}

// ---------------------------------------------------------------------------
// Freshness

/** Stale when the snapshot is older than three publish intervals (DESIGN.md, `prober_stale`). */
export function snapshotAgeMs(snapshot: Snapshot, nowMs: number): number {
	return nowMs - Date.parse(snapshot.generatedAt);
}

export function isStale(snapshot: Snapshot, nowMs: number): boolean {
	return snapshotAgeMs(snapshot, nowMs) > 3 * snapshot.publishIntervalMinutes * 60_000;
}

// ---------------------------------------------------------------------------
// Routing

export type Route =
	| { readonly kind: "overview" }
	| { readonly kind: "corridor"; readonly id: string };

const CORRIDOR_PREFIX = "#/corridor/";

export function corridorHref(id: string): string {
	return `${CORRIDOR_PREFIX}${encodeURIComponent(id)}`;
}

export function parseRoute(hash: string): Route {
	if (!hash.startsWith(CORRIDOR_PREFIX)) return { kind: "overview" };
	try {
		const id = decodeURIComponent(hash.slice(CORRIDOR_PREFIX.length));
		return id === "" ? { kind: "overview" } : { kind: "corridor", id };
	} catch {
		return { kind: "overview" };
	}
}

export function historyUrl(id: string, days: number): string {
	return `/api/v1/corridors/${encodeURIComponent(id)}/history.json?days=${days}`;
}
