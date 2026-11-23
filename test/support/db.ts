import { env } from "cloudflare:workers";

const TABLES = [
	"ticks",
	"corridors",
	"probes",
	"probe_declines",
	"probe_raw",
	"snapshots",
	"alert_notifications",
];

export async function clearTables(): Promise<void> {
	await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
}
