import type { TierHistory } from "../domain/alerts";
import { compareText } from "../domain/brands";
import { readingOf } from "../domain/publish";
import type { Snapshot, SnapshotTick, TierReading } from "../domain/snapshot";
import type {
	AmountTier,
	Corridor,
	CorridorId,
	IsoTimestamp,
	Network,
	ProbeRecord,
	RawExchange,
	TickRecord,
} from "../domain/types";
import {
	corridorRowSchema,
	errorRunRowSchema,
	probeRowSchema,
	snapshotPartRowSchema,
	snapshotRowSchema,
	tickRowSchema,
} from "./rows";

/** What the snapshot builder reads: the current corridors, their tier readings, and the last tick. */
export interface SnapshotSource {
	readonly corridors: readonly Corridor[];
	readonly tiers: readonly TierHistory[];
	readonly lastTick: SnapshotTick | null;
	/** Slot start of the first failing tick after the last healthy one. Null when the last tick is healthy. */
	readonly errorRunStart: IsoTimestamp | null;
}

export interface Store {
	/**
	 * Stores the tick, its corridors and its probes in one batch. A tick or probe
	 * already stored under the same key is kept as first written; corridors are
	 * upserted.
	 */
	saveTick(
		tick: TickRecord,
		options: { readonly dropRawBefore: IsoTimestamp | null },
	): Promise<void>;
	/** Readings of `tiers` only, so a tier removed from the config leaves the snapshot. */
	readSnapshotSource(network: Network, tiers: readonly AmountTier[]): Promise<SnapshotSource>;
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

/** Each bound JSON parameter stays well under D1's 2 MB value limit. */
const MAX_PARAMETER_BYTES = 512 * 1024;

/** UTF-16 units per stored snapshot part. Four bytes each at worst, still under D1's limit. */
const SNAPSHOT_PART_UNITS = 400_000;

/** The snapshot text in parts of at most `SNAPSHOT_PART_UNITS`, never splitting a surrogate pair. */
function snapshotParts(json: string): string[] {
	const parts: string[] = [];
	let start = 0;
	while (start < json.length) {
		let end = Math.min(start + SNAPSHOT_PART_UNITS, json.length);
		const last = json.charCodeAt(end - 1);
		if (end < json.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
		parts.push(json.slice(start, end));
		start = end;
	}
	return parts;
}

/**
 * The most `probe_raw.raw_json` holds for one probe. JSON string escaping can double
 * it inside the bound parameter, and twice this is still under D1's 2,000,000-byte limit.
 */
const RAW_BUDGET_BYTES = 900 * 1024;

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
 * handful of D1 statements however many rows it writes. Without `update`, a row
 * whose key already exists is left as it is: the first write wins.
 */
function bulkInsert<Columns extends readonly string[]>(
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
	const action = params.update === undefined ? "DO NOTHING" : `DO UPDATE SET ${params.update}`;
	const sql = `INSERT INTO ${params.table} (${params.columns.join(", ")}) SELECT ${select} FROM json_each(?1) WHERE true ON CONFLICT (${params.conflict.join(", ")}) ${action}`;
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

function byteLength(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

/** An exchange as `probe_raw` keeps it: a response body over the raw budget becomes a marker. */
type StoredExchange =
	| RawExchange
	| (Omit<RawExchange, "responseBody"> & {
			readonly responseBody: { readonly truncated: true; readonly bytes: number };
	  });

/** The exchange with its response body replaced by a marker that keeps the body's UTF-8 size. */
function truncated(exchange: RawExchange): StoredExchange {
	if (exchange.responseBody === null) return exchange;
	return {
		...exchange,
		responseBody: { truncated: true, bytes: byteLength(exchange.responseBody) },
	};
}

/**
 * The probe's raw exchanges within `RAW_BUDGET_BYTES`. Over budget, the response
 * bodies between the first and the last exchange are cut; if that is not
 * enough, those two are cut as well.
 */
function rawJson(probe: ProbeRecord): string {
	const created = probe.raw.find((exchange) => exchange.method === "POST");
	const text = (exchanges: readonly StoredExchange[]) =>
		JSON.stringify({ requestBody: created?.requestBody ?? null, exchanges });
	const whole = text(probe.raw);
	if (byteLength(whole) <= RAW_BUDGET_BYTES) return whole;
	const last = probe.raw.length - 1;
	const ends = text(
		probe.raw.map((exchange, index) =>
			index === 0 || index === last ? exchange : truncated(exchange),
		),
	);
	if (byteLength(ends) <= RAW_BUDGET_BYTES) return ends;
	return text(probe.raw.map(truncated));
}

function rawRow(probe: ProbeRecord): RowOf<typeof RAW_COLUMNS> {
	return { probe_id: probe.id, created_at: probe.startedAt, raw_json: rawJson(probe) };
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

/** A failing tick: `tickErrored` in `src/domain/alerts.ts`, in SQL. */
const ERRORED_TICK = `(aborted_reason IS 'defaults_unavailable' OR (completed > 0 AND 2 * gateway_errors >= completed))`;

/** The first failing tick after the last healthy one, however long ago that was. */
const ERROR_RUN_START = `SELECT MIN(slot_start) AS since FROM ticks WHERE network = ?1
	AND slot_start > COALESCE(
		(SELECT MAX(slot_start) FROM ticks WHERE network = ?1 AND NOT ${ERRORED_TICK}), '')`;

export function createStore(db: D1Database): Store {
	return {
		async saveTick(tick, { dropRawBefore }) {
			const { network, start } = tick.slot;
			const probes = tick.probes;
			const statements = [
				...bulkInsert(db, {
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
						ON CONFLICT (network, slot_start) DO NOTHING`,
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
				...bulkInsert(db, {
					table: "probes",
					columns: PROBE_COLUMNS,
					conflict: ["id"],
					rows: probes.map(probeRow),
				}),
				...bulkInsert(db, {
					table: "probe_declines",
					columns: DECLINE_COLUMNS,
					conflict: ["probe_id", "ordinal"],
					rows: probes.flatMap(declineRows),
				}),
				...bulkInsert(db, {
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

		async readSnapshotSource(network, tiers) {
			const [corridorRows, probeRows, tickRows, runRows] = await db.batch([
				db.prepare(`${CURRENT_CORRIDORS} ORDER BY id`).bind(network),
				db.prepare(LATEST_TWO).bind(network, JSON.stringify(tiers)),
				db
					.prepare("SELECT * FROM ticks WHERE network = ?1 ORDER BY slot_start DESC LIMIT 1")
					.bind(network),
				db.prepare(ERROR_RUN_START).bind(network),
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
				lastTick: (tickRows?.results ?? []).map((row) => tickRowSchema.parse(row))[0] ?? null,
				errorRunStart: errorRunRowSchema.parse(runRows?.results[0]).since,
			};
		},

		async saveSnapshot(snapshot) {
			const insert = db.prepare(
				"INSERT INTO snapshots (network, part, generated_at, snapshot_json) VALUES (?1, ?2, ?3, ?4)",
			);
			await db.batch([
				db.prepare("DELETE FROM snapshots WHERE network = ?1").bind(snapshot.network),
				...snapshotParts(JSON.stringify(snapshot)).map((part, index) =>
					insert.bind(snapshot.network, index, snapshot.generatedAt, part),
				),
			]);
		},

		async readSnapshotJson(network) {
			const rows = await db
				.prepare("SELECT snapshot_json FROM snapshots WHERE network = ?1 ORDER BY part")
				.bind(network)
				.all();
			if (rows.results.length === 0) return null;
			return rows.results.map((row) => snapshotPartRowSchema.parse(row).snapshot_json).join("");
		},

		async readSnapshot(network) {
			const json = await this.readSnapshotJson(network);
			return json === null ? null : snapshotRowSchema.parse({ snapshot_json: json }).snapshot_json;
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
