import type { TierHistory } from "../domain/alerts";
import { compareText } from "../domain/brands";
import { readingOf } from "../domain/publish";
import type { Snapshot, SnapshotTick, TierReading } from "../domain/snapshot";
import {
	AMOUNT_TIERS,
	type Corridor,
	type CorridorId,
	type IsoTimestamp,
	type Network,
	type ProbeRecord,
	type TickRecord,
} from "../domain/types";
import { corridorRowSchema, probeRowSchema, snapshotRowSchema, tickRowSchema } from "./rows";

/** What the snapshot builder reads: the current corridors, their tier readings, and recent ticks. */
export interface SnapshotSource {
	readonly corridors: readonly Corridor[];
	readonly tiers: readonly TierHistory[];
	/** Most recent first. */
	readonly ticks: readonly SnapshotTick[];
}

export interface Store {
	/** Upserts the tick, its corridors and its probes in one batch. */
	saveTick(
		tick: TickRecord,
		options: { readonly dropRawBefore: IsoTimestamp | null },
	): Promise<void>;
	readSnapshotSource(network: Network): Promise<SnapshotSource>;
	saveSnapshot(snapshot: Snapshot): Promise<void>;
	/** The published snapshot exactly as stored. */
	readSnapshotJson(network: Network): Promise<string | null>;
	readSnapshot(network: Network): Promise<Snapshot | null>;
	hasCorridor(network: Network, corridorId: CorridorId): Promise<boolean>;
	/** Oldest first. */
	readHistory(
		network: Network,
		corridorId: CorridorId,
		since: IsoTimestamp,
	): Promise<TierReading[]>;
}

/** Recent ticks kept in view for the start time of a `gateway_errors` alert. */
const RECENT_TICKS = 50;

/** Each bound JSON parameter stays well under D1's 2 MB value limit. */
const MAX_PARAMETER_BYTES = 512 * 1024;

type Row = Readonly<Record<string, string | number | null>>;

const CORRIDOR_COLUMNS = [
	"network",
	"id",
	"source_asset",
	"source_chain",
	"source_namespace",
	"source_symbol",
	"source_decimals",
	"destination_asset",
	"destination_chain",
	"destination_namespace",
	"destination_symbol",
	"destination_decimals",
	"first_seen",
	"last_seen",
] as const;

const PROBE_COLUMNS = [
	"id",
	"network",
	"slot_start",
	"corridor_id",
	"tier",
	"fulfillment_amount",
	"started_at",
	"quote_request_id",
	"idempotent_replay",
	"outcome",
	"requested_count",
	"quote_count",
	"operator_count",
	"best_source_amount",
	"best_spread_bps",
	"worst_spread_bps",
	"create_latency_ms",
	"first_quote_ms",
	"ready_ms",
	"min_price_hold_ms",
	"error_phase",
	"error_http_status",
	"error_code",
	"error_message",
] as const;

const DECLINE_COLUMNS = ["probe_id", "ordinal", "reason", "retry_classification", "count"] as const;
const RAW_COLUMNS = ["probe_id", "created_at", "raw_json"] as const;

type RowOf<Columns extends readonly string[]> = Readonly<
	Record<Columns[number], string | number | null>
>;

function chunkBySize(rows: readonly Row[]): string[] {
	const chunks: string[] = [];
	let current: string[] = [];
	let size = 0;
	for (const row of rows) {
		const text = JSON.stringify(row);
		if (current.length > 0 && size + text.length > MAX_PARAMETER_BYTES) {
			chunks.push(`[${current.join(",")}]`);
			current = [];
			size = 0;
		}
		current.push(text);
		size += text.length + 1;
	}
	if (current.length > 0) chunks.push(`[${current.join(",")}]`);
	return chunks;
}

function assignments(columns: readonly string[], conflict: readonly string[]): string {
	return columns
		.filter((column) => !conflict.includes(column))
		.map((column) => `${column} = excluded.${column}`)
		.join(", ");
}

/**
 * One `INSERT ... SELECT FROM json_each(?)` per chunk of rows, so a tick costs a
 * handful of D1 statements however many rows it writes.
 */
function bulkUpsert<Columns extends readonly string[]>(
	db: D1Database,
	params: {
		readonly table: string;
		readonly columns: Columns;
		readonly conflict: readonly Columns[number][];
		readonly update?: string;
		readonly rows: readonly RowOf<Columns>[];
	},
): D1PreparedStatement[] {
	const select = params.columns.map((column) => `json_extract(value, '$.${column}')`).join(", ");
	const update = params.update ?? assignments(params.columns, params.conflict);
	const sql = `INSERT INTO ${params.table} (${params.columns.join(", ")}) SELECT ${select} FROM json_each(?1) WHERE true ON CONFLICT (${params.conflict.join(", ")}) DO UPDATE SET ${update}`;
	return chunkBySize(params.rows).map((json) => db.prepare(sql).bind(json));
}

function corridorRow(
	network: Network,
	seen: IsoTimestamp,
	corridor: Corridor,
): RowOf<typeof CORRIDOR_COLUMNS> {
	const { source, destination } = corridor;
	return {
		network,
		id: corridor.id,
		source_asset: source.id,
		source_chain: source.chainId,
		source_namespace: source.namespace,
		source_symbol: source.symbol,
		source_decimals: source.decimals,
		destination_asset: destination.id,
		destination_chain: destination.chainId,
		destination_namespace: destination.namespace,
		destination_symbol: destination.symbol,
		destination_decimals: destination.decimals,
		first_seen: seen,
		last_seen: seen,
	};
}

function probeRow(probe: ProbeRecord): RowOf<typeof PROBE_COLUMNS> {
	const reading = readingOf(probe);
	const { outcome, timings } = probe;
	const error = outcome.kind === "gateway_error" ? outcome : null;
	const requestedCount =
		outcome.kind === "quoted" || outcome.kind === "declined" || outcome.kind === "silent"
			? outcome.requestedCount
			: null;
	return {
		id: probe.id,
		network: probe.slot.network,
		slot_start: probe.slot.start,
		corridor_id: probe.target.corridor.id,
		tier: probe.target.tier,
		fulfillment_amount: probe.target.fulfillmentAmount,
		started_at: probe.startedAt,
		quote_request_id: probe.quoteRequestId,
		idempotent_replay: probe.idempotentReplay ? 1 : 0,
		outcome: outcome.kind,
		requested_count: requestedCount,
		quote_count: reading.quoteCount,
		operator_count: reading.operatorCount,
		best_source_amount: reading.bestSourceAmount,
		best_spread_bps: reading.bestSpreadBps,
		worst_spread_bps: reading.worstSpreadBps,
		create_latency_ms: timings.createLatencyMs,
		first_quote_ms: timings.firstQuoteMs,
		ready_ms: timings.readyMs,
		min_price_hold_ms: reading.minPriceHoldMs,
		error_phase: error?.phase ?? null,
		error_http_status: error?.httpStatus ?? null,
		error_code: error?.code ?? null,
		error_message: error?.message ?? null,
	};
}

function declineRows(probe: ProbeRecord): RowOf<typeof DECLINE_COLUMNS>[] {
	return readingOf(probe).declines.map((decline, ordinal) => ({
		probe_id: probe.id,
		ordinal,
		reason: decline.reason,
		retry_classification: decline.retryClassification,
		count: decline.count,
	}));
}

function rawRow(probe: ProbeRecord): RowOf<typeof RAW_COLUMNS> {
	const created = probe.raw.find((exchange) => exchange.method === "POST");
	return {
		probe_id: probe.id,
		created_at: probe.startedAt,
		raw_json: JSON.stringify({ requestBody: created?.requestBody ?? null, exchanges: probe.raw }),
	};
}

/** The corridors of the latest successful discovery. */
const CURRENT_CORRIDORS = `SELECT * FROM corridors WHERE network = ?1
	AND last_seen = (SELECT MAX(last_seen) FROM corridors WHERE network = ?1)`;

const DECLINES_JSON = `(SELECT json_group_array(json_object(
		'reason', d.reason, 'retryClassification', d.retry_classification, 'count', d.count))
	FROM (SELECT * FROM probe_declines WHERE probe_id = p.id ORDER BY ordinal) AS d) AS declines_json`;

/** The latest two probes of every current corridor at every tier, through `probes_latest`. */
const LATEST_TWO = `WITH current AS (${CURRENT_CORRIDORS})
	SELECT p.*, ${DECLINES_JSON}
	FROM current AS c CROSS JOIN json_each(?2) AS t
	JOIN probes AS p ON p.rowid IN (
		SELECT q.rowid FROM probes AS q
		WHERE q.network = ?1 AND q.corridor_id = c.id AND q.tier = t.value
		ORDER BY q.slot_start DESC LIMIT 2)`;

export function createStore(db: D1Database): Store {
	return {
		async saveTick(tick, { dropRawBefore }) {
			const { network, start } = tick.slot;
			const probes = tick.probes;
			const statements = [
				...bulkUpsert(db, {
					table: "corridors",
					columns: CORRIDOR_COLUMNS,
					conflict: ["network", "id"],
					update: `${assignments(CORRIDOR_COLUMNS, ["network", "id", "first_seen", "last_seen"])},
						first_seen = MIN(first_seen, excluded.first_seen),
						last_seen = MAX(last_seen, excluded.last_seen)`,
					rows: tick.corridors.map((corridor) => corridorRow(network, start, corridor)),
				}),
				db
					.prepare(
						`INSERT INTO ticks (network, slot_start, slot_index, started_at, finished_at,
							corridor_count, planned, completed, gateway_errors, aborted_reason, aborted_message)
						VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
						ON CONFLICT (network, slot_start) DO UPDATE SET slot_index = excluded.slot_index,
							started_at = excluded.started_at, finished_at = excluded.finished_at,
							corridor_count = excluded.corridor_count, planned = excluded.planned,
							completed = excluded.completed, gateway_errors = excluded.gateway_errors,
							aborted_reason = excluded.aborted_reason, aborted_message = excluded.aborted_message`,
					)
					.bind(
						network,
						start,
						tick.slot.index,
						tick.startedAt,
						tick.finishedAt,
						tick.corridors.length,
						tick.planned,
						probes.length,
						probes.filter((probe) => probe.outcome.kind === "gateway_error").length,
						tick.aborted?.reason ?? null,
						tick.aborted?.message ?? null,
					),
				...bulkUpsert(db, {
					table: "probes",
					columns: PROBE_COLUMNS,
					conflict: ["id"],
					rows: probes.map(probeRow),
				}),
				...(probes.length === 0
					? []
					: [
							db
								.prepare(
									"DELETE FROM probe_declines WHERE probe_id IN (SELECT value FROM json_each(?1))",
								)
								.bind(JSON.stringify(probes.map((probe) => probe.id))),
						]),
				...bulkUpsert(db, {
					table: "probe_declines",
					columns: DECLINE_COLUMNS,
					conflict: ["probe_id", "ordinal"],
					rows: probes.flatMap(declineRows),
				}),
				...bulkUpsert(db, {
					table: "probe_raw",
					columns: RAW_COLUMNS,
					conflict: ["probe_id"],
					rows: probes.map(rawRow),
				}),
				...(dropRawBefore === null
					? []
					: [db.prepare("DELETE FROM probe_raw WHERE created_at < ?1").bind(dropRawBefore)]),
			];
			await db.batch(statements);
		},

		async readSnapshotSource(network) {
			const [corridorRows, probeRows, tickRows] = await db.batch([
				db.prepare(`${CURRENT_CORRIDORS} ORDER BY id`).bind(network),
				db.prepare(LATEST_TWO).bind(network, JSON.stringify(AMOUNT_TIERS)),
				db
					.prepare("SELECT * FROM ticks WHERE network = ?1 ORDER BY slot_start DESC LIMIT ?2")
					.bind(network, RECENT_TICKS),
			]);
			const corridors = (corridorRows?.results ?? []).map((row) => corridorRowSchema.parse(row));
			const readings = (probeRows?.results ?? [])
				.map((row) => probeRowSchema.parse(row))
				.sort((a, b) => compareText(b.slotStart, a.slotStart));
			const byTier = new Map<string, TierHistory>();
			for (const { corridorId, reading } of readings) {
				const key = `${corridorId} ${reading.tier}`;
				const seen = byTier.get(key);
				if (seen === undefined) {
					byTier.set(key, { corridorId, latest: reading, previous: null });
				} else if (seen.previous === null) {
					byTier.set(key, { ...seen, previous: reading });
				}
			}
			return {
				corridors,
				tiers: [...byTier.values()],
				ticks: (tickRows?.results ?? []).map((row) => tickRowSchema.parse(row)),
			};
		},

		async saveSnapshot(snapshot) {
			await db
				.prepare(
					`INSERT INTO snapshots (network, generated_at, snapshot_json) VALUES (?1, ?2, ?3)
					ON CONFLICT (network) DO UPDATE SET generated_at = excluded.generated_at,
						snapshot_json = excluded.snapshot_json`,
				)
				.bind(snapshot.network, snapshot.generatedAt, JSON.stringify(snapshot))
				.run();
		},

		async readSnapshotJson(network) {
			const json = await db
				.prepare("SELECT snapshot_json FROM snapshots WHERE network = ?1")
				.bind(network)
				.first("snapshot_json");
			return typeof json === "string" ? json : null;
		},

		async readSnapshot(network) {
			const row = await db
				.prepare("SELECT snapshot_json FROM snapshots WHERE network = ?1")
				.bind(network)
				.first();
			return row === null ? null : snapshotRowSchema.parse(row).snapshot_json;
		},

		async hasCorridor(network, corridorId) {
			const row = await db
				.prepare("SELECT 1 FROM corridors WHERE network = ?1 AND id = ?2")
				.bind(network, corridorId)
				.first();
			return row !== null;
		},

		async readHistory(network, corridorId, since) {
			const { results } = await db
				.prepare(
					`SELECT p.*, ${DECLINES_JSON} FROM probes AS p
					WHERE p.network = ?1 AND p.corridor_id = ?2 AND p.started_at >= ?3
					ORDER BY p.started_at`,
				)
				.bind(network, corridorId, since)
				.all();
			return results.map((row) => probeRowSchema.parse(row).reading);
		},
	};
}
