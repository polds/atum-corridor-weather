-- Daily figures: one row per network, UTC day, corridor and tier, reduced from
-- that day's probes by the maintenance cron (src/store/store.ts). A day is the
-- UTC day of the probes' slot_start. Kept for DAILY_RETENTION_DAYS; the probes
-- themselves are deleted after PROBE_RETENTION_DAYS.
--
-- WITHOUT ROWID, so a row costs one written row and no separate key index. The
-- key leads with the day: the maintenance run checks, writes and deletes one day
-- at a time, each a key range. The history of one corridor seeks each of its
-- days in that key (day IN (...) AND corridor_id = ?), one seek per day.
CREATE TABLE daily_stats (
	network TEXT NOT NULL,
	day TEXT NOT NULL,
	corridor_id TEXT NOT NULL,
	tier TEXT NOT NULL,
	probes INTEGER NOT NULL,
	quoted INTEGER NOT NULL,
	declined INTEGER NOT NULL,
	silent INTEGER NOT NULL,
	incomplete INTEGER NOT NULL,
	gateway_error INTEGER NOT NULL,
	best_spread_min_bps REAL,
	best_spread_mean_bps REAL,
	best_spread_max_bps REAL,
	max_operator_count INTEGER NOT NULL,
	first_quote_min_ms INTEGER,
	first_quote_mean_ms REAL,
	first_quote_max_ms INTEGER,
	-- [{"reason": ..., "count": ...}] ordered by reason; count sums the day's decline counts.
	declines_json TEXT NOT NULL,
	PRIMARY KEY (network, day, corridor_id, tier)
) WITHOUT ROWID;

-- The tick deleted raw exchanges by created_at. The maintenance run deletes them
-- by day, as a range of probe ids, which embed the slot start. Nothing else
-- reads created_at, and the index cost one written row per insert and per delete.
DROP INDEX probe_raw_created;
