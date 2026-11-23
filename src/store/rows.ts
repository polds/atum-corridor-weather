/** Schemas for what the store reads back from D1. */
import { z } from "zod";
import type { LastQuote } from "../domain/alerts";
import {
	isAssetId,
	isAtomicAmount,
	isChainId,
	isCorridorId,
	isIsoTimestamp,
	namespaceOf,
} from "../domain/brands";
import { type AnnouncedAlert, isAlertKey } from "../domain/notify";
import { dayAt, dayOfProbeId, isUtcDay, type UtcDay } from "../domain/retention";
import {
	type Alert,
	type DailyDecline,
	type DailyFigures,
	type DailyRange,
	SNAPSHOT_SCHEMA_VERSION,
	type Snapshot,
	type SnapshotDecline,
	type SnapshotTick,
	type TierReading,
} from "../domain/snapshot";
import { AMOUNT_TIERS, type Asset, type Corridor, type ProbeOutcomeKind } from "../domain/types";

const OUTCOME_KINDS = [
	"quoted",
	"declined",
	"silent",
	"incomplete",
	"gateway_error",
] as const satisfies readonly ProbeOutcomeKind[];

const iso = z.string().refine(isIsoTimestamp, "not an ISO timestamp");
const atomic = z.string().refine(isAtomicAmount, "not an atomic amount");
const assetId = z.string().refine(isAssetId, "not an asset id");
const chainId = z.string().refine(isChainId, "not a chain id");
const corridorId = z.string().refine(isCorridorId, "not a corridor id");
const tier = z.enum(AMOUNT_TIERS);
const outcome = z.enum(OUTCOME_KINDS);
const utcDay = z.string().refine(isUtcDay, "not a UTC day");
const count = z.number().int().nonnegative();

/** A TEXT column that holds JSON. */
function jsonText<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>) {
	return z.string().transform((text, context): T => {
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "not JSON" });
			return z.NEVER;
		}
		const parsed = schema.safeParse(value);
		if (parsed.success) return parsed.data;
		for (const issue of parsed.error.issues) context.addIssue(issue);
		return z.NEVER;
	});
}

const declineSchema: z.ZodType<SnapshotDecline, z.ZodTypeDef, unknown> = z.object({
	reason: z.string(),
	retryClassification: z.string().nullable(),
	count: z.number().int(),
});

const readingSchema: z.ZodType<TierReading, z.ZodTypeDef, unknown> = z.object({
	tier,
	fulfillmentAmount: atomic,
	probedAt: iso,
	outcome,
	quoteCount: z.number().int(),
	operatorCount: z.number().int(),
	bestSourceAmount: atomic.nullable(),
	bestSpreadBps: z.number().nullable(),
	worstSpreadBps: z.number().nullable(),
	firstQuoteMs: z.number().nullable(),
	readyMs: z.number().nullable(),
	minPriceHoldMs: z.number().nullable(),
	declines: z.array(declineSchema),
});

/** A `probes` row with its declines folded into `declines_json`. */
export const probeRowSchema = z
	.object({
		corridor_id: corridorId,
		tier,
		fulfillment_amount: atomic,
		started_at: iso,
		outcome,
		quote_count: z.number().int(),
		operator_count: z.number().int(),
		best_source_amount: atomic.nullable(),
		best_spread_bps: z.number().nullable(),
		worst_spread_bps: z.number().nullable(),
		first_quote_ms: z.number().nullable(),
		ready_ms: z.number().nullable(),
		min_price_hold_ms: z.number().nullable(),
		declines_json: jsonText(z.array(declineSchema)),
	})
	.transform((row) => ({
		corridorId: row.corridor_id,
		reading: {
			tier: row.tier,
			fulfillmentAmount: row.fulfillment_amount,
			probedAt: row.started_at,
			outcome: row.outcome,
			quoteCount: row.quote_count,
			operatorCount: row.operator_count,
			bestSourceAmount: row.best_source_amount,
			bestSpreadBps: row.best_spread_bps,
			worstSpreadBps: row.worst_spread_bps,
			firstQuoteMs: row.first_quote_ms,
			readyMs: row.ready_ms,
			minPriceHoldMs: row.min_price_hold_ms,
			declines: row.declines_json,
		} satisfies TierReading,
	}));

const assetSchema = z
	.object({ id: assetId, chainId, symbol: z.string(), decimals: z.number().int() })
	.transform((asset, context): Asset => {
		const namespace = namespaceOf(asset.chainId);
		if (namespace === null) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "unknown namespace" });
			return z.NEVER;
		}
		return { ...asset, namespace };
	});

export const corridorRowSchema: z.ZodType<Corridor, z.ZodTypeDef, unknown> = z
	.object({
		id: corridorId,
		source_asset: z.string(),
		source_chain: z.string(),
		source_symbol: z.string(),
		source_decimals: z.number(),
		destination_asset: z.string(),
		destination_chain: z.string(),
		destination_symbol: z.string(),
		destination_decimals: z.number(),
	})
	.transform((row, context): Corridor => {
		const source = assetSchema.safeParse({
			id: row.source_asset,
			chainId: row.source_chain,
			symbol: row.source_symbol,
			decimals: row.source_decimals,
		});
		const destination = assetSchema.safeParse({
			id: row.destination_asset,
			chainId: row.destination_chain,
			symbol: row.destination_symbol,
			decimals: row.destination_decimals,
		});
		if (!source.success || !destination.success) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid corridor asset" });
			return z.NEVER;
		}
		return { id: row.id, source: source.data, destination: destination.data };
	});

export const tickRowSchema: z.ZodType<SnapshotTick, z.ZodTypeDef, unknown> = z
	.object({
		slot_start: iso,
		finished_at: iso,
		planned: z.number().int(),
		completed: z.number().int(),
		gateway_errors: z.number().int(),
		aborted_reason: z.string().nullable(),
	})
	.transform((row) => ({
		slotStart: row.slot_start,
		finishedAt: row.finished_at,
		planned: row.planned,
		completed: row.completed,
		gatewayErrors: row.gateway_errors,
		aborted: row.aborted_reason,
	}));

/** The last quote of a corridor at a configured tier, and the first probe after it. */
export const lastQuoteRowSchema: z.ZodType<LastQuote, z.ZodTypeDef, unknown> = z
	.object({ corridor_id: corridorId, quoted_at: iso, first_unquoted_at: iso.nullable() })
	.transform((row) => ({
		corridorId: row.corridor_id,
		quotedAt: row.quoted_at,
		firstUnquotedAt: row.first_unquoted_at,
	}));

/** `MIN(slot_start)` of the current run of failing ticks; null when there is none. */
export const errorRunRowSchema = z.object({ since: iso.nullable() });

const alertKind = z.enum(["prober_stale", "gateway_errors", "quotes_lost", "slow_quotes"]);
const alertSeverity = z.enum(["warning", "critical"]);

const alertSchema: z.ZodType<Alert, z.ZodTypeDef, unknown> = z.object({
	kind: alertKind,
	severity: alertSeverity,
	corridorId: corridorId.nullable(),
	message: z.string(),
	since: iso,
});

/**
 * A snapshot stored before `publishIntervalMinutes` existed was published on
 * every tick, so a missing value is the tick interval. Such a row lasts until the
 * first publish after a deploy.
 */
export const snapshotSchema: z.ZodType<Snapshot, z.ZodTypeDef, unknown> = z
	.object({
		schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
		network: z.enum(["testnet", "mainnet"]),
		generatedAt: iso,
		tickIntervalMinutes: z.number(),
		publishIntervalMinutes: z.number().optional(),
		cadence: z.object({ probesPerTick: z.number(), sweepHours: z.number() }),
		tiers: z.array(tier),
		lastTick: z
			.object({
				slotStart: iso,
				finishedAt: iso,
				planned: z.number(),
				completed: z.number(),
				gatewayErrors: z.number(),
				aborted: z.string().nullable(),
			})
			.nullable(),
		assets: z.array(
			z.object({
				id: assetId,
				chainId,
				chainLabel: z.string(),
				symbol: z.string(),
				decimals: z.number(),
			}),
		),
		corridors: z.array(
			z.object({
				id: corridorId,
				source: assetId,
				destination: assetId,
				condition: z.enum(["fair", "cloudy", "stormy", "unknown"]),
				lastProbedAt: iso.nullable(),
				tiers: z.array(readingSchema),
			}),
		),
		alerts: z.array(alertSchema),
	})
	.transform((snapshot) => ({
		...snapshot,
		publishIntervalMinutes: snapshot.publishIntervalMinutes ?? snapshot.tickIntervalMinutes,
	}));

export const snapshotRowSchema = z.object({ snapshot_json: jsonText(snapshotSchema) });

export const snapshotPartRowSchema = z.object({ snapshot_json: z.string() });

export const announcedAlertRowSchema: z.ZodType<AnnouncedAlert, z.ZodTypeDef, unknown> = z
	.object({
		alert_key: z.string().refine(isAlertKey, "not an alert key"),
		kind: alertKind,
		severity: alertSeverity,
		corridor_id: corridorId.nullable(),
		since: iso,
		announced_at: iso,
	})
	.transform((row) => ({
		key: row.alert_key,
		kind: row.kind,
		severity: row.severity,
		corridorId: row.corridor_id,
		since: row.since,
		announcedAt: row.announced_at,
	}));

/** `MIN(id)` of a table keyed by probe id, read as the day of that probe's slot. */
export const oldestProbeIdRowSchema = z.object({
	id: z
		.string()
		.nullable()
		.transform((id, context): UtcDay | null => {
			if (id === null) return null;
			const day = dayOfProbeId(id);
			if (day === null) {
				context.addIssue({ code: z.ZodIssueCode.custom, message: "not a probe id" });
				return z.NEVER;
			}
			return day;
		}),
});

/** `MIN(slot_start)` of `ticks`, read as its day. */
export const oldestTickRowSchema = z.object({
	slot_start: iso
		.nullable()
		.transform((start) => (start === null ? null : dayAt(Date.parse(start)))),
});

export const oldestFiguresRowSchema = z.object({ day: utcDay.nullable() });

export const figuresDayRowSchema = z.object({ day: utcDay });

const declineCountSchema: z.ZodType<DailyDecline, z.ZodTypeDef, unknown> = z.object({
	reason: z.string(),
	count,
});

/** A range is whole or absent: the three aggregates are null together. */
function range(min: number | null, mean: number | null, max: number | null): DailyRange | null {
	return min === null || mean === null || max === null ? null : { min, mean, max };
}

export const dailyRowSchema: z.ZodType<DailyFigures, z.ZodTypeDef, unknown> = z
	.object({
		day: utcDay,
		tier,
		probes: count,
		quoted: count,
		declined: count,
		silent: count,
		incomplete: count,
		gateway_error: count,
		best_spread_min_bps: z.number().nullable(),
		best_spread_mean_bps: z.number().nullable(),
		best_spread_max_bps: z.number().nullable(),
		max_operator_count: count,
		first_quote_min_ms: z.number().nullable(),
		first_quote_mean_ms: z.number().nullable(),
		first_quote_max_ms: z.number().nullable(),
		declines_json: jsonText(z.array(declineCountSchema)),
	})
	.transform((row) => ({
		day: row.day,
		tier: row.tier,
		probes: row.probes,
		outcomes: {
			quoted: row.quoted,
			declined: row.declined,
			silent: row.silent,
			incomplete: row.incomplete,
			gateway_error: row.gateway_error,
		},
		bestSpreadBps: range(
			row.best_spread_min_bps,
			row.best_spread_mean_bps,
			row.best_spread_max_bps,
		),
		maxOperatorCount: row.max_operator_count,
		firstQuoteMs: range(row.first_quote_min_ms, row.first_quote_mean_ms, row.first_quote_max_ms),
		declines: row.declines_json,
	}));
