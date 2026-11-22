import { isCorridorId, isoAt } from "../domain/brands";
import { buildHealth, buildHistory, buildMetrics } from "../domain/publish";
import type { Store } from "../store/store";
import type { ConfigResult } from "./config";

export interface RouteDeps {
	readonly config: ConfigResult;
	readonly store: Store;
	readonly assets: Pick<Fetcher, "fetch">;
	/** Epoch ms of the request. */
	readonly nowMs: number;
}

const DISCLAIMER =
	"Corridor Weather is an unofficial open-source project. It is not an Atum product or service.";
const DEFAULT_HISTORY_DAYS = 7;
const MAX_HISTORY_DAYS = 30;
const DAY_MS = 86_400_000;
const PUBLIC_CACHE = "public, max-age=60";
const HISTORY_PATH = /^\/api\/v1\/corridors\/(.+)\/history\.json$/;

function respond(
	request: Request,
	body: string,
	init: { readonly status?: number; readonly type: string; readonly cache: string },
): Response {
	return new Response(request.method === "HEAD" ? null : body, {
		status: init.status ?? 200,
		headers: {
			"content-type": init.type,
			"cache-control": init.cache,
			"x-disclaimer": DISCLAIMER,
		},
	});
}

function json(request: Request, value: unknown, status = 200, cache = "no-store"): Response {
	return respond(request, JSON.stringify(value), {
		status,
		type: "application/json; charset=utf-8",
		cache,
	});
}

function problem(request: Request, status: number, error: string, message: string): Response {
	return json(request, { error, message }, status);
}

function historyDays(param: string | null): number | null {
	if (param === null) return DEFAULT_HISTORY_DAYS;
	if (!/^\d+$/.test(param)) return null;
	const days = Number(param);
	return days >= 1 && days <= MAX_HISTORY_DAYS ? days : null;
}

function decodedCorridor(encoded: string): string | null {
	try {
		return decodeURIComponent(encoded);
	} catch {
		return null;
	}
}

/** The read-only API. Anything outside `/api/` and `/metrics` goes to the static assets. */
export async function handleRequest(request: Request, deps: RouteDeps): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;
	if (!path.startsWith("/api/") && path !== "/metrics") return deps.assets.fetch(request);
	if (request.method !== "GET" && request.method !== "HEAD") {
		const response = problem(request, 405, "method_not_allowed", "Only GET and HEAD are served.");
		response.headers.set("allow", "GET, HEAD");
		return response;
	}
	if (!deps.config.ok) {
		return problem(request, 500, "config_invalid", deps.config.errors.join("; "));
	}
	const { config } = deps.config;
	const { store, nowMs } = deps;

	if (path === "/api/v1/snapshot.json") {
		const snapshot = await store.readSnapshotJson(config.network);
		if (snapshot === null) {
			return problem(request, 404, "no_snapshot", "No tick has published a snapshot yet.");
		}
		return respond(request, snapshot, {
			type: "application/json; charset=utf-8",
			cache: PUBLIC_CACHE,
		});
	}

	if (path === "/api/v1/health" || path === "/metrics") {
		const snapshot = await store.readSnapshot(config.network);
		const health = buildHealth({
			network: config.network,
			nowMs,
			tickIntervalMinutes: config.tickIntervalMinutes,
			snapshot,
		});
		if (path === "/metrics") {
			return respond(request, buildMetrics({ network: config.network, snapshot, health }), {
				type: "text/plain; version=0.0.4; charset=utf-8",
				cache: "no-store",
			});
		}
		return json(request, health, health.status === "alerting" ? 503 : 200);
	}

	const history = HISTORY_PATH.exec(path);
	if (history !== null) {
		const corridorId = decodedCorridor(history[1] ?? "");
		if (corridorId === null || !isCorridorId(corridorId)) {
			return problem(request, 404, "unknown_corridor", "No such corridor.");
		}
		const days = historyDays(url.searchParams.get("days"));
		if (days === null) {
			return problem(request, 400, "invalid_days", `days must be 1 to ${MAX_HISTORY_DAYS}.`);
		}
		if (!(await store.hasCorridor(config.network, corridorId))) {
			return problem(request, 404, "unknown_corridor", "No such corridor.");
		}
		const readings = await store.readHistory(
			config.network,
			corridorId,
			isoAt(nowMs - days * DAY_MS),
		);
		return json(
			request,
			buildHistory({ network: config.network, corridorId, nowMs, days, readings }),
			200,
			PUBLIC_CACHE,
		);
	}

	return problem(request, 404, "not_found", `No route for ${path}.`);
}
