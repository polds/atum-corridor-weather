/** Schemas for what the store reads back from D1. */
import { z } from "zod";
import {
	isAssetId,
	isAtomicAmount,
	isChainId,
	isCorridorId,
	isIsoTimestamp,
	namespaceOf,
} from "../domain/brands";
import {
	type Alert,
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
		slot_start: iso,
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
		slotStart: row.slot_start,
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

/** `MIN(slot_start)` of the current run of failing ticks; null when there is none. */
export const errorRunRowSchema = z.object({ since: iso.nullable() });

const alertSchema: z.ZodType<Alert, z.ZodTypeDef, unknown> = z.object({
	kind: z.enum(["prober_stale", "gateway_errors", "quotes_lost", "slow_quotes"]),
	severity: z.enum(["warning", "critical"]),
	corridorId: corridorId.nullable(),
	message: z.string(),
	since: iso,
});

export const snapshotSchema: z.ZodType<Snapshot, z.ZodTypeDef, unknown> = z.object({
	schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
	network: z.enum(["testnet", "mainnet"]),
	generatedAt: iso,
	tickIntervalMinutes: z.number(),
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
});

export const snapshotRowSchema = z.object({ snapshot_json: jsonText(snapshotSchema) });

export const snapshotPartRowSchema = z.object({ snapshot_json: z.string() });
