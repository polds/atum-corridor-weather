import { buildHealth } from "../domain/publish";
import type { HealthReport, Snapshot } from "../domain/snapshot";
import type { Store } from "../store/store";
import type { Config } from "./config";

/** The report `/api/v1/health` serves and the canary announces, with the snapshot it came from. */
export async function readHealth(deps: {
	readonly config: Config;
	readonly store: Store;
	/** Epoch ms of the check. */
	readonly nowMs: number;
}): Promise<{ readonly snapshot: Snapshot | null; readonly health: HealthReport }> {
	const { config } = deps;
	const snapshot = await deps.store.readSnapshot(config.network);
	const health = buildHealth({
		network: config.network,
		nowMs: deps.nowMs,
		publishIntervalMinutes: config.publishIntervalMinutes,
		snapshot,
	});
	return { snapshot, health };
}
