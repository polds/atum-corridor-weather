/**
 * The public read model. The Worker writes these documents and the dashboard
 * reads them. This file is the contract between the two, so both import it.
 *
 * Nothing here names a settlement operator. Operator addresses stay in the
 * store until publishing them is agreed (docs/DESIGN.md, open question 4).
 */
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
	readonly tickIntervalMinutes: number;
	/** Probes per tick and the resulting hours for one sweep of every target. */
	readonly cadence: { readonly probesPerTick: number; readonly sweepHours: number };
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

export interface CorridorHistory {
	readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
	readonly network: Network;
	readonly corridorId: CorridorId;
	readonly generatedAt: IsoTimestamp;
	readonly days: number;
	/** Oldest first. */
	readonly points: readonly HistoryPoint[];
}

export interface HealthReport {
	readonly status: "ok" | "alerting";
	readonly network: Network;
	readonly checkedAt: IsoTimestamp;
	readonly lastTickFinishedAt: IsoTimestamp | null;
	readonly alerts: readonly Alert[];
}
