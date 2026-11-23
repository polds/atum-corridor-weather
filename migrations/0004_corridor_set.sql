-- The hash of each network's current corridor list, and the slot it was first
-- seen in. A tick writes the corridor rows only when its list hashes to another
-- value, and then writes this row in the same batch. A database with corridor
-- rows and no row here writes its list once on the next tick.
CREATE TABLE corridor_sets (
	network TEXT PRIMARY KEY,
	hash TEXT NOT NULL,
	first_seen TEXT NOT NULL
);
