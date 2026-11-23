/**
 * The public read model. The Worker writes these documents and the dashboard
 * reads them. This file is the contract between the two, so both import it.
 *
 * Nothing here names a settlement operator. Operator addresses stay in the
 * store until publishing them is agreed (docs/DESIGN.md, open question 4).
 */
import type { UtcDay } from "./retention";
import type {
	AmountTier,
	AssetId,
	AtomicAmount,
	ChainId,
	CorridorId,
	IsoTimestamp,
	Network,
	ProbeOutcomeKind,
} from "./types";

export const SNAPSHOT_SCHEMA_VERSION = 1;

/** `fair`: every tier quoted. `cloudy`: some did. `stormy`: none did. */
export type Condition = "fair" | "cloudy" | "stormy" | "unknown";

export interface SnapshotAsset {
	readonly id: AssetId;
	readonly chainId: ChainId;
	readonly chainLabel: string;
	readonly symbol: string;
	readonly decimals: number;
}

export interface TierReading {
	readonly tier: AmountTier;
	readonly fulfillmentAmount: AtomicAmount;
	readonly probedAt: IsoTimestamp;
	readonly outcome: ProbeOutcomeKind;
	readonly quoteCount: number;
	readonly operatorCount: number;
	readonly bestSourceAmount: AtomicAmount | null;
	readonly bestSpreadBps: number | null;
	readonly worstSpreadBps: number | null;
	readonly firstQuoteMs: number | null;
	readonly readyMs: number | null;
	readonly minPriceHoldMs: number | null;
	readonly declines: readonly SnapshotDecline[];
}

export interface SnapshotDecline {
	readonly reason: string;
	readonly retryClassification: string | null;
	readonly count: number;
}

export interface CorridorConditions {
	readonly id: CorridorId;
	readonly source: AssetId;
	readonly destination: AssetId;
	readonly condition: Condition;
	/** Most recent probe across tiers. Null when the corridor was never probed. */
	readonly lastProbedAt: IsoTimestamp | null;
	/** Latest reading per tier. A tier that was never probed is absent. */
	readonly tiers: readonly TierReading[];
}

export type AlertKind = "prober_stale" | "gateway_errors" | "quotes_lost" | "slow_quotes";
export type AlertSeverity = "warning" | "critical";

export interface Alert {
	readonly kind: AlertKind;
	readonly severity: AlertSeverity;
	/** Absent for network-wide alerts. */
	readonly corridorId: CorridorId | null;
	readonly message: string;
	readonly since: IsoTimestamp;
}

export interface SnapshotTick {
	readonly slotStart: IsoTimestamp;
	readonly finishedAt: IsoTimestamp;
	readonly planned: number;
	readonly completed: number;
	readonly gatewayErrors: number;
	readonly aborted: string | null;
}

export interface Snapshot {
	readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
	readonly network: Network;
	readonly generatedAt: IsoTimestamp;
	/** Minutes between ticks: the probe cadence. */
	readonly tickIntervalMinutes: number;
	/** Minutes between publishes: how often this document and its alerts are rebuilt. */
	readonly publishIntervalMinutes: number;
	/** Probes a tick runs, after the subrequest cap, and the resulting hours for one sweep of every target. */
	readonly cadence: { readonly probesPerTick: number; readonly sweepHours: number };
	/** The configured amount tiers, in small, typical, large order. Readings cover these only. */
	readonly tiers: readonly AmountTier[];
	readonly lastTick: SnapshotTick | null;
	readonly assets: readonly SnapshotAsset[];
	readonly corridors: readonly CorridorConditions[];
	readonly alerts: readonly Alert[];
}

export interface HistoryPoint {
	readonly probedAt: IsoTimestamp;
	readonly tier: AmountTier;
	readonly fulfillmentAmount: AtomicAmount;
	readonly outcome: ProbeOutcomeKind;
	readonly quoteCount: number;
	readonly operatorCount: number;
	readonly bestSpreadBps: number | null;
	readonly firstQuoteMs: number | null;
	readonly declines: readonly SnapshotDecline[];
}

/** Lowest, mean and highest of one measure over the probes of a day that have a value for it. */
export interface DailyRange {
	readonly min: number;
	readonly mean: number;
	readonly max: number;
}

/** One decline reason over a day. */
export interface DailyDecline {
	/** A published decline code, or `OTHER`, as in `SnapshotDecline`. */
	readonly reason: string;
	/** The sum of this reason's `count` over the day's probes: how many declines gave it. */
	readonly count: number;
}

/**
 * One UTC day of one corridor tier, reduced from that day's probes. The probes
 * are deleted after a few days; these figures are kept for months. Counts only,
 * so no operator is named.
 */
export interface DailyFigures {
	/** `YYYY-MM-DD`, the UTC day of the probes' slot start. */
	readonly day: UtcDay;
	readonly tier: AmountTier;
	/** Probes of this tier on this day. */
	readonly probes: number;
	/** Probes by outcome. The five counts add up to `probes`. */
	readonly outcomes: Readonly<Record<ProbeOutcomeKind, number>>;
	/** `bestSpreadBps` of the day's probes that have one. Null when none has. */
	readonly bestSpreadBps: DailyRange | null;
	/** The highest `operatorCount` of any probe of the day. */
	readonly maxOperatorCount: number;
	/** `firstQuoteMs` of the day's probes that have one. Null when none has. */
	readonly firstQuoteMs: DailyRange | null;
	/** Ordered by reason. Empty when no probe of the day was declined. */
	readonly declines: readonly DailyDecline[];
}

export interface CorridorHistory {
	readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
	readonly network: Network;
	readonly corridorId: CorridorId;
	readonly generatedAt: IsoTimestamp;
	/** The days `points` covers, counted back from `generatedAt`. */
	readonly days: number;
	/** Every probe of the last `days` days. Oldest first. */
	readonly points: readonly HistoryPoint[];
	/**
	 * Daily figures of every tier, oldest day first, then small, typical, large.
	 * They cover up to `DAILY_RETENTION_DAYS` complete days before `generatedAt`;
	 * a day with no probe of a tier has no entry for it. Absent from documents
	 * published before daily figures existed.
	 */
	readonly daily: readonly DailyFigures[];
}

export interface HealthReport {
	readonly status: "ok" | "alerting";
	readonly network: Network;
	readonly checkedAt: IsoTimestamp;
	readonly lastTickFinishedAt: IsoTimestamp | null;
	readonly alerts: readonly Alert[];
}
