import { alertsFor, type LastQuote, staleAlert, type TierLatest } from "./alerts";
import { compareText, isoAt } from "./brands";
import { chainLabel } from "./chains";
import { conditionOf } from "./conditions";
import { probeTargets, type TierAmounts } from "./schedule";
import {
	type Alert,
	type CorridorConditions,
	type CorridorHistory,
	type HealthReport,
	SNAPSHOT_SCHEMA_VERSION,
	type Snapshot,
	type SnapshotAsset,
	type SnapshotTick,
	type TierReading,
} from "./snapshot";
import {
	AMOUNT_TIERS,
	type Asset,
	type AtomicAmount,
	type Corridor,
	type CorridorId,
	type IsoTimestamp,
	type Network,
	type ProbeRecord,
} from "./types";

function minOf(values: readonly number[]): number | null {
	return values.length === 0 ? null : Math.min(...values);
}

function maxOf(values: readonly number[]): number | null {
	return values.length === 0 ? null : Math.max(...values);
}

/** EVM-style hex addresses compare case-insensitively; base58 addresses do not. */
function operatorKey(address: string): string {
	return address.startsWith("0x") ? address.toLowerCase() : address;
}

/** The public reading of one probe. It counts operators and never names one. */
export function readingOf(probe: ProbeRecord): TierReading {
	const { outcome } = probe;
	const quotes = outcome.kind === "quoted" ? outcome.quotes : [];
	const declines = outcome.kind === "quoted" || outcome.kind === "declined" ? outcome.declines : [];
	const spreads = quotes.flatMap((quote) => (quote.spreadBps === null ? [] : [quote.spreadBps]));
	const best = quotes.reduce<AtomicAmount | null>(
		(lowest, quote) =>
			lowest === null || BigInt(quote.sourceAmount) < BigInt(lowest) ? quote.sourceAmount : lowest,
		null,
	);
	return {
		tier: probe.target.tier,
		fulfillmentAmount: probe.target.fulfillmentAmount,
		probedAt: probe.startedAt,
		outcome: outcome.kind,
		quoteCount: quotes.length,
		operatorCount: new Set(quotes.map((quote) => operatorKey(quote.settlerAddress))).size,
		bestSourceAmount: best,
		bestSpreadBps: minOf(spreads),
		worstSpreadBps: maxOf(spreads),
		firstQuoteMs: probe.timings.firstQuoteMs,
		readyMs: probe.timings.readyMs,
		minPriceHoldMs: minOf(
			quotes.flatMap((quote) => (quote.priceHoldMs === null ? [] : [quote.priceHoldMs])),
		),
		declines: declines.map((decline) => ({
			reason: decline.reason,
			retryClassification: decline.retryClassification,
			count: decline.count,
		})),
	};
}

export interface SnapshotInput {
	readonly network: Network;
	readonly nowMs: number;
	readonly tickIntervalMinutes: number;
	readonly probesPerTick: number;
	readonly slowQuoteMs: number;
	readonly tierAmounts: TierAmounts;
	/** The corridors of the latest successful discovery. */
	readonly corridors: readonly Corridor[];
	readonly tiers: readonly TierLatest[];
	readonly lastQuotes: readonly LastQuote[];
	readonly lastTick: SnapshotTick | null;
	/** Slot start of the current run of failing ticks, or null. See `AlertInput`. */
	readonly errorRunStart: IsoTimestamp | null;
}

function snapshotAsset(asset: Asset): SnapshotAsset {
	return {
		id: asset.id,
		chainId: asset.chainId,
		chainLabel: chainLabel(asset.chainId),
		symbol: asset.symbol,
		decimals: asset.decimals,
	};
}

function sweepHours(targets: number, probesPerTick: number, intervalMinutes: number): number {
	if (targets === 0) return 0;
	const ticks = Math.max(1, targets / probesPerTick);
	return Math.round((ticks * intervalMinutes * 100) / 60) / 100;
}

export function buildSnapshot(input: SnapshotInput): Snapshot {
	const assets = new Map<string, SnapshotAsset>();
	for (const corridor of input.corridors) {
		assets.set(corridor.source.id, snapshotAsset(corridor.source));
		assets.set(corridor.destination.id, snapshotAsset(corridor.destination));
	}
	const latestByCorridor = new Map<CorridorId, TierReading[]>();
	for (const { corridorId, latest } of input.tiers) {
		const readings = latestByCorridor.get(corridorId) ?? [];
		readings.push(latest);
		latestByCorridor.set(corridorId, readings);
	}
	const corridors = [...input.corridors]
		.sort((a, b) => compareText(a.id, b.id))
		.map((corridor): CorridorConditions => {
			const tiers = (latestByCorridor.get(corridor.id) ?? []).sort(
				(a, b) => AMOUNT_TIERS.indexOf(a.tier) - AMOUNT_TIERS.indexOf(b.tier),
			);
			const lastProbedAt = tiers.reduce<CorridorConditions["lastProbedAt"]>(
				(latest, reading) =>
					latest === null || reading.probedAt > latest ? reading.probedAt : latest,
				null,
			);
			return {
				id: corridor.id,
				source: corridor.source.id,
				destination: corridor.destination.id,
				condition: conditionOf(tiers),
				lastProbedAt,
				tiers,
			};
		});
	const { lastTick } = input;
	return {
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		network: input.network,
		generatedAt: isoAt(input.nowMs),
		tickIntervalMinutes: input.tickIntervalMinutes,
		cadence: {
			probesPerTick: input.probesPerTick,
			sweepHours: sweepHours(
				probeTargets(input.corridors, input.tierAmounts).length,
				input.probesPerTick,
				input.tickIntervalMinutes,
			),
		},
		tiers: AMOUNT_TIERS.filter((tier) => input.tierAmounts[tier] !== undefined),
		lastTick,
		assets: [...assets.values()].sort((a, b) => compareText(a.id, b.id)),
		corridors,
		alerts: alertsFor({
			nowMs: input.nowMs,
			tickIntervalMinutes: input.tickIntervalMinutes,
			slowQuoteMs: input.slowQuoteMs,
			lastTick,
			errorRunStart: input.errorRunStart,
			tiers: input.tiers,
			lastQuotes: input.lastQuotes,
		}),
	};
}

export function buildHistory(params: {
	readonly network: Network;
	readonly corridorId: CorridorId;
	readonly nowMs: number;
	readonly days: number;
	readonly readings: readonly TierReading[];
}): CorridorHistory {
	return {
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		network: params.network,
		corridorId: params.corridorId,
		generatedAt: isoAt(params.nowMs),
		days: params.days,
		points: [...params.readings]
			.sort(
				(a, b) =>
					compareText(a.probedAt, b.probedAt) ||
					AMOUNT_TIERS.indexOf(a.tier) - AMOUNT_TIERS.indexOf(b.tier),
			)
			.map((reading) => ({
				probedAt: reading.probedAt,
				tier: reading.tier,
				fulfillmentAmount: reading.fulfillmentAmount,
				outcome: reading.outcome,
				quoteCount: reading.quoteCount,
				operatorCount: reading.operatorCount,
				bestSpreadBps: reading.bestSpreadBps,
				firstQuoteMs: reading.firstQuoteMs,
				declines: reading.declines,
			})),
	};
}

/**
 * The stored snapshot's alerts with `prober_stale` recomputed for `nowMs`.
 * `alerting` means a critical alert is active.
 */
export function buildHealth(params: {
	readonly network: Network;
	readonly nowMs: number;
	readonly tickIntervalMinutes: number;
	readonly snapshot: Snapshot | null;
}): HealthReport {
	const lastTickFinishedAt = params.snapshot?.lastTick?.finishedAt ?? null;
	const stale = staleAlert({
		nowMs: params.nowMs,
		tickIntervalMinutes: params.tickIntervalMinutes,
		lastTickFinishedAt,
	});
	const alerts = [
		...(stale === null ? [] : [stale]),
		...(params.snapshot?.alerts ?? []).filter((alert) => alert.kind !== "prober_stale"),
	];
	return {
		status: alerts.some((alert) => alert.severity === "critical") ? "alerting" : "ok",
		network: params.network,
		checkedAt: isoAt(params.nowMs),
		lastTickFinishedAt,
		alerts,
	};
}

type Labels = Readonly<Record<string, string>>;

function escapeLabel(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function sample(name: string, labels: Labels, value: number): string {
	const text = Object.entries(labels)
		.map(([key, label]) => `${key}="${escapeLabel(label)}"`)
		.join(",");
	return `${name}{${text}} ${value}`;
}

function family(name: string, help: string, samples: readonly string[]): string[] {
	return [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...samples];
}

const ALERT_SERIES: readonly Pick<Alert, "kind" | "severity">[] = [
	{ kind: "prober_stale", severity: "critical" },
	{ kind: "gateway_errors", severity: "critical" },
	{ kind: "quotes_lost", severity: "critical" },
	{ kind: "slow_quotes", severity: "warning" },
];

/** Prometheus text exposition of the snapshot and the current health alerts. */
export function buildMetrics(params: {
	readonly network: Network;
	readonly snapshot: Snapshot | null;
	readonly health: HealthReport;
}): string {
	const { network, snapshot, health } = params;
	const readings = (snapshot?.corridors ?? []).flatMap((corridor) =>
		corridor.tiers.map((reading) => ({
			labels: { network, corridor: corridor.id, tier: reading.tier },
			reading,
		})),
	);
	const perTier = (
		name: string,
		help: string,
		value: (reading: TierReading) => number | null,
	): string[] =>
		family(
			name,
			help,
			readings.flatMap(({ labels, reading }) => {
				const measured = value(reading);
				return measured === null ? [] : [sample(name, labels, measured)];
			}),
		);
	const tick = snapshot?.lastTick ?? null;
	const perTick = (name: string, help: string, value: (tick: SnapshotTick) => number): string[] =>
		family(name, help, tick === null ? [] : [sample(name, { network }, value(tick))]);
	const lines = [
		...perTier(
			"corridor_weather_quote_count",
			"Quotes listed by the latest probe of a corridor tier.",
			(reading) => reading.quoteCount,
		),
		...perTier(
			"corridor_weather_operator_count",
			"Distinct operators that quoted the latest probe of a corridor tier.",
			(reading) => reading.operatorCount,
		),
		...perTier(
			"corridor_weather_best_spread_bps",
			"Best quoted price over face value, in basis points, for pegged pairs.",
			(reading) => reading.bestSpreadBps,
		),
		...perTier(
			"corridor_weather_first_quote_ms",
			"Milliseconds from the create call to the first listed quote.",
			(reading) => reading.firstQuoteMs,
		),
		...perTier(
			"corridor_weather_last_probe_timestamp_seconds",
			"Unix time of the latest probe of a corridor tier.",
			(reading) => Date.parse(reading.probedAt) / 1000,
		),
		...perTick(
			"corridor_weather_last_tick_timestamp_seconds",
			"Unix time the last tick finished.",
			(last) => Date.parse(last.finishedAt) / 1000,
		),
		...perTick(
			"corridor_weather_last_tick_planned",
			"Probes the last tick planned.",
			(last) => last.planned,
		),
		...perTick(
			"corridor_weather_last_tick_completed",
			"Probes the last tick finished.",
			(last) => last.completed,
		),
		...perTick(
			"corridor_weather_last_tick_gateway_errors",
			"Probes in the last tick that ended in a gateway error.",
			(last) => last.gatewayErrors,
		),
		...perTick(
			"corridor_weather_last_tick_aborted",
			"1 when the last tick stopped before its plan was done.",
			(last) => (last.aborted === null ? 0 : 1),
		),
		...family(
			"corridor_weather_alert",
			"Active alerts by kind.",
			ALERT_SERIES.map(({ kind, severity }) =>
				sample(
					"corridor_weather_alert",
					{ network, kind, severity },
					health.alerts.filter((alert) => alert.kind === kind).length,
				),
			),
		),
	];
	return `${lines.join("\n")}\n`;
}
