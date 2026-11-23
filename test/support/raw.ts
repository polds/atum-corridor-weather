import { env } from "cloudflare:workers";

/**
 * The query docs/RUNBOOK.md gives for reading a probe's exchanges: each response
 * body as text, following a `{"sameAs": n}` marker to exchange `n`. Rows stored
 * before the marker existed hold every body as text and read the same way.
 */
export const RAW_EXCHANGES_SQL = `SELECT e.key AS exchange,
  json_extract(e.value, '$.method') AS method,
  json_extract(e.value, '$.path') AS path,
  json_extract(e.value, '$.status') AS status,
  CASE WHEN json_type(e.value, '$.responseBody.sameAs') IS NULL
    THEN json_extract(e.value, '$.responseBody')
    ELSE json_extract(r.raw_json, '$.exchanges[' || json_extract(e.value, '$.responseBody.sameAs') || '].responseBody')
  END AS response_body
FROM probe_raw AS r, json_each(r.raw_json, '$.exchanges') AS e
WHERE r.probe_id = ?1
ORDER BY e.key`;

export interface ReadExchange {
	readonly method: string;
	readonly path: string;
	readonly status: number | null;
	readonly responseBody: string | null;
}

export async function readRawExchanges(probeId: string): Promise<ReadExchange[]> {
	const { results } = await env.DB.prepare(RAW_EXCHANGES_SQL).bind(probeId).all();
	return results.map((row) => ({
		method: String(row.method),
		path: String(row.path),
		status: typeof row.status === "number" ? row.status : null,
		responseBody: typeof row.response_body === "string" ? row.response_body : null,
	}));
}
