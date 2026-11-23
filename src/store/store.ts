import type { LastQuote, TierLatest } from "../domain/alerts";
import { isoAt } from "../domain/brands";
import { type AnnouncedAlert, alertKeyOf, type NotificationPlan } from "../domain/notify";
import { readingOf } from "../domain/publish";
import {
	addDays,
	dayStartMs,
	type OldestDays,
	probeIdRange,
	type UtcDay,
} from "../domain/retention";
import type { DailyFigures, Snapshot, SnapshotTick, TierReading } from "../domain/snapshot";
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
	announcedAlertRowSchema,
	corridorRowSchema,
	dailyRowSchema,
	errorRunRowSchema,
	figuresDayRowSchema,
	lastQuoteRowSchema,
	oldestFiguresRowSchema,
	oldestProbeIdRowSchema,
	oldestTickRowSchema,
	probeRowSchema,
	snapshotPartRowSchema,
	snapshotRowSchema,
	tickRowSchema,
} from "./rows";

/** What the snapshot builder reads: the current corridors, their tier readings, and the last tick. */
export interface SnapshotSource {
	readonly corridors: readonly Corridor[];
	/** The latest reading of every current corridor at every configured tier it was probed at. */
	readonly tiers: readonly TierLatest[];
	/** The last quote of every current corridor at a configured tier, however old. */
	readonly lastQuotes: readonly LastQuote[];
	readonly lastTick: SnapshotTick | null;
	/** Slot start of the first failing tick after the last healthy one. Null when the last tick is healthy. */
	readonly errorRunStart: IsoTimestamp | null;
}

/** What a store call cost, as D1 reports it in `meta`. */
export interface D1Usage {
	readonly rowsRead: number;
	readonly rowsWritten: number;
	/** The size of the database after the call, as D1 reports it in `meta.size_after`. */
	readonly databaseBytes: number;
}

export interface Store {
	/**
	 * Stores the tick, its corridors and its probes in one batch. A tick or probe
	 * already stored under the same key is kept as first written. The corridors
	 * are upserted, with their hash, only when `corridorsHash` differs from the
	 * stored one, so an unchanged list costs no write.
	 */
	saveTick(tick: TickRecord): Promise<void>;
	/** The oldest stored day of probes, ticks, raw exchanges and daily figures. */
	readOldestDays(
		network: Network,
	): Promise<{ readonly oldest: OldestDays; readonly usage: D1Usage }>;
	/**
	 * Writes the daily figures of the first `limit` of `candidates` that have
	 * probes and no figures yet, each computed inside D1 from that day's probes.
	 * Returns those days, oldest first.
	 */
	writeDailyFigures(
		network: Network,
		candidates: readonly UtcDay[],
		limit: number,
	): Promise<{ readonly days: readonly UtcDay[]; readonly usage: D1Usage }>;
	/**
	 * Deletes the probes, declines, raw exchanges and ticks of `day`. A day that
	 * has probes and no figures keeps everything.
	 */
	deleteProbeDay(
		network: Network,
		day: UtcDay,
	): Promise<{ readonly deleted: boolean; readonly usage: D1Usage }>;
	deleteRawDay(
		network: Network,
		day: UtcDay,
	): Promise<{ readonly deleted: boolean; readonly usage: D1Usage }>;
	deleteFiguresDay(
		network: Network,
		day: UtcDay,
	): Promise<{ readonly deleted: boolean; readonly usage: D1Usage }>;
	/** The daily figures of one corridor on `days`, in no particular order. */
	readDailyFigures(
		network: Network,
		corridorId: CorridorId,
		days: readonly UtcDay[],
	): Promise<DailyFigures[]>;
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
	/** Alerts announced as raised and not yet announced as cleared. */
	readAnnouncedAlerts(network: Network): Promise<AnnouncedAlert[]>;
	/**
	 * Records a delivered plan in one batch: inserts the raised alerts, keeping a
	 * row that already exists, and deletes the cleared ones.
	 */
	applyAnnouncements(
		network: Network,
		announcements: NotificationPlan & { readonly announcedAt: IsoTimestamp },
	): Promise<void>;
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

const ANNOUNCED_COLUMNS = [
	"network",
	"alert_key",
	"kind",
	"severity",
	"corridor_id",
	"since",
	"announced_at",
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

/**
 * A response body as `probe_raw` keeps it: the text, null when none was read, a
 * marker with the UTF-8 size of a body cut for the raw budget, or the index of
 * the exchange that holds the same text.
 */
type StoredBody =
	| string
	| null
	| { readonly truncated: true; readonly bytes: number }
	| { readonly sameAs: number };

type StoredExchange = Omit<RawExchange, "responseBody"> & { readonly responseBody: StoredBody };

/**
 * The exchanges as stored. The bodies at the indexes `cut` names become cut
 * markers. A kept body equal to the kept body of the exchange before it becomes
 * `{ sameAs }`, the index of the first exchange of that run, which holds the text.
 */
function storedExchanges(
	exchanges: readonly RawExchange[],
	cut: (index: number) => boolean,
): StoredExchange[] {
	let holder = -1;
	return exchanges.map((exchange, index): StoredExchange => {
		const body = exchange.responseBody;
		if (body === null) {
			holder = -1;
			return exchange;
		}
		if (cut(index)) {
			holder = -1;
			return { ...exchange, responseBody: { truncated: true, bytes: byteLength(body) } };
		}
		if (holder >= 0 && exchanges[index - 1]?.responseBody === body) {
			return { ...exchange, responseBody: { sameAs: holder } };
		}
		holder = index;
		return exchange;
	});
}

/**
 * The probe's raw exchanges within `RAW_BUDGET_BYTES`, a repeated body stored
 * once. Over budget, the response bodies between the first and the last
 * exchange are cut; if that is not enough, those two are cut as well.
 */
function rawJson(probe: ProbeRecord): string {
	const created = probe.raw.find((exchange) => exchange.method === "POST");
	const last = probe.raw.length - 1;
	const text = (cut: (index: number) => boolean) =>
		JSON.stringify({
			requestBody: created?.requestBody ?? null,
			exchanges: storedExchanges(probe.raw, cut),
		});
	const whole = text(() => false);
	if (byteLength(whole) <= RAW_BUDGET_BYTES) return whole;
	const ends = text((index) => index !== 0 && index !== last);
	if (byteLength(ends) <= RAW_BUDGET_BYTES) return ends;
	return text(() => true);
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

/** The latest probe of every current corridor at every tier in `?2`, through `probes_latest`. */
const LATEST = `WITH current AS (${CURRENT_CORRIDORS})
	SELECT p.*, ${DECLINES_JSON}
	FROM current AS c CROSS JOIN json_each(?2) AS t
	JOIN probes AS p ON p.rowid = (
		SELECT q.rowid FROM probes AS q
		WHERE q.network = ?1 AND q.corridor_id = c.id AND q.tier = t.value
		ORDER BY q.slot_start DESC LIMIT 1)`;

/**
 * Per current corridor, the last quoted probe at a tier in `?2`, through the
 * partial index `probes_quoted`, and the first probe at such a tier after it,
 * through `probes_history`. Probes are written once, so both hold still until
 * the corridor is quoted again.
 */
const LAST_QUOTES = `WITH current AS (${CURRENT_CORRIDORS}),
	last AS (
		SELECT c.id AS corridor_id, MAX((
			SELECT q.started_at FROM probes AS q
			WHERE q.network = ?1 AND q.corridor_id = c.id AND q.tier = t.value AND q.outcome = 'quoted'
			ORDER BY q.slot_start DESC LIMIT 1)) AS quoted_at
		FROM current AS c CROSS JOIN json_each(?2) AS t
		GROUP BY c.id)
	SELECT corridor_id, quoted_at, (
		SELECT p.started_at FROM probes AS p
		WHERE p.network = ?1 AND p.corridor_id = last.corridor_id AND p.started_at > last.quoted_at
			AND p.tier IN (SELECT value FROM json_each(?2))
		ORDER BY p.started_at LIMIT 1) AS first_unquoted_at
	FROM last WHERE quoted_at IS NOT NULL`;

/** A failing tick: `tickErrored` in `src/domain/alerts.ts`, in SQL. */
const ERRORED_TICK = `(aborted_reason IS 'defaults_unavailable' OR (completed > 0 AND 2 * gateway_errors >= completed))`;

/** The first failing tick after the last healthy one, however long ago that was. */
const ERROR_RUN_START = `SELECT MIN(slot_start) AS since FROM ticks WHERE network = ?1
	AND slot_start > COALESCE(
		(SELECT MAX(slot_start) FROM ticks WHERE network = ?1 AND NOT ${ERRORED_TICK}), '')`;

/**
 * The probes of one day: the ids in [`?3`, `?4`), which `probeIdRange` makes
 * the day `?2` of network `?1`. The range alone selects them. A `network = ?1`
 * term would lead SQLite to scan every probe of the network through `probes_latest`.
 */
const DAY_PROBES = "SELECT * FROM probes WHERE id >= ?3 AND id < ?4";

/**
 * The daily figures of one day, computed from its probes and their declines in
 * one statement. Each probe and decline row of the day is read once per pass.
 */
const WRITE_FIGURES = `INSERT INTO daily_stats (network, day, corridor_id, tier, probes,
		quoted, declined, silent, incomplete, gateway_error,
		best_spread_min_bps, best_spread_mean_bps, best_spread_max_bps, max_operator_count,
		first_quote_min_ms, first_quote_mean_ms, first_quote_max_ms, declines_json)
	WITH day AS (${DAY_PROBES}),
	reasons AS (
		SELECT corridor_id, tier, json_group_array(json_object('reason', reason, 'count', count)) AS declines_json
		FROM (SELECT p.corridor_id, p.tier, d.reason, SUM(d.count) AS count
			FROM day AS p JOIN probe_declines AS d ON d.probe_id = p.id
			GROUP BY p.corridor_id, p.tier, d.reason
			ORDER BY p.corridor_id, p.tier, d.reason)
		GROUP BY corridor_id, tier)
	SELECT ?1, ?2, p.corridor_id, p.tier, COUNT(*),
		SUM(p.outcome = 'quoted'), SUM(p.outcome = 'declined'), SUM(p.outcome = 'silent'),
		SUM(p.outcome = 'incomplete'), SUM(p.outcome = 'gateway_error'),
		MIN(p.best_spread_bps), AVG(p.best_spread_bps), MAX(p.best_spread_bps), MAX(p.operator_count),
		MIN(p.first_quote_ms), AVG(p.first_quote_ms), MAX(p.first_quote_ms),
		COALESCE(MAX(r.declines_json), '[]')
	FROM day AS p LEFT JOIN reasons AS r ON r.corridor_id = p.corridor_id AND r.tier = p.tier
	WHERE true
	GROUP BY p.corridor_id, p.tier
	ON CONFLICT (network, day, corridor_id, tier) DO UPDATE SET
		probes = excluded.probes, quoted = excluded.quoted, declined = excluded.declined,
		silent = excluded.silent, incomplete = excluded.incomplete,
		gateway_error = excluded.gateway_error,
		best_spread_min_bps = excluded.best_spread_min_bps,
		best_spread_mean_bps = excluded.best_spread_mean_bps,
		best_spread_max_bps = excluded.best_spread_max_bps,
		max_operator_count = excluded.max_operator_count,
		first_quote_min_ms = excluded.first_quote_min_ms,
		first_quote_mean_ms = excluded.first_quote_mean_ms,
		first_quote_max_ms = excluded.first_quote_max_ms,
		declines_json = excluded.declines_json`;

/** Of the candidate days `?2` (`[{day, from, to}]`), the first `?3` that have probes and no figures. */
const DAYS_WITHOUT_FIGURES = `SELECT json_extract(c.value, '$.day') AS day FROM json_each(?2) AS c
	WHERE EXISTS (SELECT 1 FROM probes
			WHERE id >= json_extract(c.value, '$.from') AND id < json_extract(c.value, '$.to'))
		AND NOT EXISTS (SELECT 1 FROM daily_stats
			WHERE network = ?1 AND day = json_extract(c.value, '$.day'))
	ORDER BY day LIMIT ?3`;

/**
 * True when the day of probe ids [`?1`, `?2`) of network `?3` may be deleted: it
 * has figures for day `?4`, or it has no probes. Uncorrelated, so D1 reads it once.
 */
const PROBE_DAY_DELETABLE = `(EXISTS (SELECT 1 FROM daily_stats WHERE network = ?3 AND day = ?4)
	OR NOT EXISTS (SELECT 1 FROM probes WHERE id >= ?1 AND id < ?2))`;

function usageOf(results: readonly D1Result[]): D1Usage {
	return {
		rowsRead: results.reduce((sum, result) => sum + result.meta.rows_read, 0),
		rowsWritten: results.reduce((sum, result) => sum + result.meta.rows_written, 0),
		databaseBytes: results.at(-1)?.meta.size_after ?? 0,
	};
}

function changed(results: readonly D1Result[]): boolean {
	return results.some((result) => result.meta.changes > 0);
}

export function createStore(db: D1Database): Store {
	return {
		async saveTick(tick) {
			const { network, start } = tick.slot;
			const probes = tick.probes;
			const hash = tick.corridorsHash;
			// Two ticks that race here both write the same rows, which upsert to the same state.
			const storedHash =
				hash === null
					? null
					: await db
							.prepare("SELECT hash FROM corridor_sets WHERE network = ?1")
							.bind(network)
							.first("hash");
			const corridorWrites =
				hash === null || storedHash === hash
					? []
					: [
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
									`INSERT INTO corridor_sets (network, hash, first_seen) VALUES (?1, ?2, ?3)
									ON CONFLICT (network) DO UPDATE SET hash = excluded.hash, first_seen = excluded.first_seen`,
								)
								.bind(network, hash, start),
						];
			const statements = [
				...corridorWrites,
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
			];
			await db.batch(statements);
		},

		async readSnapshotSource(network, tiers) {
			const tierList = JSON.stringify(tiers);
			const [corridorRows, probeRows, quoteRows, tickRows, runRows] = await db.batch([
				db.prepare(`${CURRENT_CORRIDORS} ORDER BY id`).bind(network),
				db.prepare(LATEST).bind(network, tierList),
				db.prepare(LAST_QUOTES).bind(network, tierList),
				db
					.prepare("SELECT * FROM ticks WHERE network = ?1 ORDER BY slot_start DESC LIMIT 1")
					.bind(network),
				db.prepare(ERROR_RUN_START).bind(network),
			]);
			const corridors = (corridorRows?.results ?? []).map((row) => corridorRowSchema.parse(row));
			return {
				corridors,
				tiers: (probeRows?.results ?? []).map((row) => {
					const { corridorId, reading } = probeRowSchema.parse(row);
					return { corridorId, latest: reading };
				}),
				lastQuotes: (quoteRows?.results ?? []).map((row) => lastQuoteRowSchema.parse(row)),
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

		async readOldestDays(network) {
			const { from, to } = probeIdRange(network, null);
			const results = await db.batch([
				db.prepare("SELECT MIN(id) AS id FROM probes WHERE id >= ?1 AND id < ?2").bind(from, to),
				db
					.prepare("SELECT MIN(slot_start) AS slot_start FROM ticks WHERE network = ?1")
					.bind(network),
				db
					.prepare(
						"SELECT MIN(probe_id) AS id FROM probe_raw WHERE probe_id >= ?1 AND probe_id < ?2",
					)
					.bind(from, to),
				db.prepare("SELECT MIN(day) AS day FROM daily_stats WHERE network = ?1").bind(network),
			]);
			const [probes, ticks, raw, figures] = results.map((result) => result.results[0]);
			return {
				oldest: {
					probes: oldestProbeIdRowSchema.parse(probes).id,
					ticks: oldestTickRowSchema.parse(ticks).slot_start,
					raw: oldestProbeIdRowSchema.parse(raw).id,
					figures: oldestFiguresRowSchema.parse(figures).day,
				},
				usage: usageOf(results),
			};
		},

		async writeDailyFigures(network, candidates, limit) {
			const pending = await db
				.prepare(DAYS_WITHOUT_FIGURES)
				.bind(
					network,
					JSON.stringify(candidates.map((day) => ({ day, ...probeIdRange(network, day) }))),
					limit,
				)
				.all();
			const days = pending.results.map((row) => figuresDayRowSchema.parse(row).day);
			if (days.length === 0) return { days, usage: usageOf([pending]) };
			const results = await db.batch(
				days.map((day) => {
					const { from, to } = probeIdRange(network, day);
					return db.prepare(WRITE_FIGURES).bind(network, day, from, to);
				}),
			);
			return { days, usage: usageOf([pending, ...results]) };
		},

		async deleteProbeDay(network, day) {
			const { from, to } = probeIdRange(network, day);
			const guard = [from, to, network, day] as const;
			const deletable = (sql: string) => db.prepare(`${sql} AND ${PROBE_DAY_DELETABLE}`);
			const results = await db.batch([
				deletable("DELETE FROM probe_declines WHERE probe_id >= ?1 AND probe_id < ?2").bind(
					...guard,
				),
				deletable("DELETE FROM probe_raw WHERE probe_id >= ?1 AND probe_id < ?2").bind(...guard),
				deletable(
					"DELETE FROM ticks WHERE network = ?3 AND slot_start >= ?5 AND slot_start < ?6",
				).bind(...guard, isoAt(dayStartMs(day)), isoAt(dayStartMs(addDays(day, 1)))),
				deletable("DELETE FROM probes WHERE id >= ?1 AND id < ?2").bind(...guard),
			]);
			return { deleted: changed(results), usage: usageOf(results) };
		},

		async deleteRawDay(network, day) {
			const { from, to } = probeIdRange(network, day);
			const result = await db
				.prepare("DELETE FROM probe_raw WHERE probe_id >= ?1 AND probe_id < ?2")
				.bind(from, to)
				.run();
			return { deleted: changed([result]), usage: usageOf([result]) };
		},

		async deleteFiguresDay(network, day) {
			const result = await db
				.prepare("DELETE FROM daily_stats WHERE network = ?1 AND day = ?2")
				.bind(network, day)
				.run();
			return { deleted: changed([result]), usage: usageOf([result]) };
		},

		async readDailyFigures(network, corridorId, days) {
			const { results } = await db
				.prepare(
					`SELECT * FROM daily_stats WHERE network = ?1
					AND day IN (SELECT value FROM json_each(?2)) AND corridor_id = ?3`,
				)
				.bind(network, JSON.stringify(days), corridorId)
				.all();
			return results.map((row) => dailyRowSchema.parse(row));
		},

		async readAnnouncedAlerts(network) {
			const { results } = await db
				.prepare("SELECT * FROM alert_notifications WHERE network = ?1 ORDER BY alert_key")
				.bind(network)
				.all();
			return results.map((row) => announcedAlertRowSchema.parse(row));
		},

		async applyAnnouncements(network, { raised, cleared, announcedAt }) {
			await db.batch([
				...bulkInsert(db, {
					table: "alert_notifications",
					columns: ANNOUNCED_COLUMNS,
					conflict: ["network", "alert_key"],
					rows: raised.map((alert) => ({
						network,
						alert_key: alertKeyOf(alert),
						kind: alert.kind,
						severity: alert.severity,
						corridor_id: alert.corridorId,
						since: alert.since,
						announced_at: announcedAt,
					})),
				}),
				db
					.prepare(
						"DELETE FROM alert_notifications WHERE network = ?1 AND alert_key IN (SELECT value FROM json_each(?2))",
					)
					.bind(network, JSON.stringify(cleared.map((alert) => alert.key))),
			]);
		},
	};
}
