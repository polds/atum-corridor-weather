-- Corridor Weather store. Ticks and probes are written once, keyed by a natural
-- key: the first write wins, so a re-run of the same tick slot leaves the rows as
-- they were. Corridors and the snapshot are upserted.

CREATE TABLE ticks (
	network TEXT NOT NULL,
	slot_start TEXT NOT NULL,
	slot_index INTEGER NOT NULL,
	started_at TEXT NOT NULL,
	finished_at TEXT NOT NULL,
	corridor_count INTEGER NOT NULL,
	planned INTEGER NOT NULL,
	completed INTEGER NOT NULL,
	gateway_errors INTEGER NOT NULL,
	aborted_reason TEXT,
	aborted_message TEXT,
	PRIMARY KEY (network, slot_start)
);

CREATE TABLE corridors (
	network TEXT NOT NULL,
	id TEXT NOT NULL,
	source_asset TEXT NOT NULL,
	source_chain TEXT NOT NULL,
	source_namespace TEXT NOT NULL,
	source_symbol TEXT NOT NULL,
	source_decimals INTEGER NOT NULL,
	destination_asset TEXT NOT NULL,
	destination_chain TEXT NOT NULL,
	destination_namespace TEXT NOT NULL,
	destination_symbol TEXT NOT NULL,
	destination_decimals INTEGER NOT NULL,
	first_seen TEXT NOT NULL,
	last_seen TEXT NOT NULL,
	PRIMARY KEY (network, id)
);

CREATE INDEX corridors_last_seen ON corridors (network, last_seen);

-- One narrow row per probe with the columns the snapshot and the history read.
CREATE TABLE probes (
	id TEXT PRIMARY KEY,
	network TEXT NOT NULL,
	slot_start TEXT NOT NULL,
	corridor_id TEXT NOT NULL,
	tier TEXT NOT NULL,
	fulfillment_amount TEXT NOT NULL,
	started_at TEXT NOT NULL,
	quote_request_id TEXT,
	idempotent_replay INTEGER NOT NULL,
	outcome TEXT NOT NULL,
	requested_count INTEGER,
	quote_count INTEGER NOT NULL,
	operator_count INTEGER NOT NULL,
	best_source_amount TEXT,
	best_spread_bps REAL,
	worst_spread_bps REAL,
	create_latency_ms INTEGER,
	first_quote_ms INTEGER,
	ready_ms INTEGER,
	min_price_hold_ms INTEGER,
	error_phase TEXT,
	error_http_status INTEGER,
	error_code TEXT,
	error_message TEXT
);

-- The latest two probes of one corridor tier.
CREATE INDEX probes_latest ON probes (network, corridor_id, tier, slot_start);
-- The history of one corridor in a time range.
CREATE INDEX probes_history ON probes (network, corridor_id, started_at);

CREATE TABLE probe_declines (
	probe_id TEXT NOT NULL,
	ordinal INTEGER NOT NULL,
	reason TEXT NOT NULL,
	retry_classification TEXT,
	count INTEGER NOT NULL,
	PRIMARY KEY (probe_id, ordinal)
);

-- The request body and every HTTP exchange of a probe. Response bodies are cut
-- when one probe's exchanges pass the raw budget in src/store/store.ts. Operator
-- addresses live here and nowhere public.
CREATE TABLE probe_raw (
	probe_id TEXT PRIMARY KEY,
	created_at TEXT NOT NULL,
	raw_json TEXT NOT NULL
);

CREATE INDEX probe_raw_created ON probe_raw (created_at);

-- The published snapshot, one row per network.
CREATE TABLE snapshots (
	network TEXT PRIMARY KEY,
	generated_at TEXT NOT NULL,
	snapshot_json TEXT NOT NULL
);
