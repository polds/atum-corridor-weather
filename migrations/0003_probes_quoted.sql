-- The last quoted probe of one corridor tier, for the quotes_lost alert. Partial,
-- so it holds only quoted probes and a lookup is one seek however long a corridor
-- has gone without a quote.
CREATE INDEX probes_quoted ON probes (network, corridor_id, tier, slot_start) WHERE outcome = 'quoted';
