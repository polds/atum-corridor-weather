import {
	type Expiry,
	earlierDay,
	expiryOf,
	FIGURES_DAYS_PER_RUN,
	figureCandidates,
	type UtcDay,
} from "../domain/retention";
import type { D1Usage, Store } from "../store/store";
import type { Config } from "./config";

export interface MaintenanceDeps {
	readonly config: Config;
	readonly store: Store;
	/** Epoch ms. */
	readonly now: () => number;
}

/** What one run did, as it logs it. */
export interface MaintenanceRun {
	readonly event: "maintenance";
	/** Days whose daily figures this run wrote, oldest first. */
	readonly figuresDays: readonly UtcDay[];
	/** The day whose probes, declines, raw exchanges and ticks this run deleted. */
	readonly probesDayDeleted: UtcDay | null;
	readonly rawDayDeleted: UtcDay | null;
	readonly figuresDayDeleted: UtcDay | null;
	/** Expired days still stored after this run, of the kind with the most. 0 in steady state. */
	readonly backlogDays: number;
	readonly databaseBytes: number;
	readonly rowsRead: number;
	readonly rowsWritten: number;
}

/**
 * One daily maintenance run, the four steps of docs/DESIGN.md "Retention and long
 * history" in order: write figures, then delete the oldest expired day of
 * probes, of raw exchanges and of figures. Each delete step takes the oldest day
 * as the store holds it after the steps before, so a second run, or a run after
 * a crash at any point, converges.
 */
export async function runMaintenance(deps: MaintenanceDeps): Promise<MaintenanceRun> {
	const { config, store } = deps;
	const { network, retention } = config;
	const nowMs = deps.now();
	const usage: D1Usage[] = [];
	const spend = <T extends { readonly usage: D1Usage }>(result: T): T => {
		usage.push(result.usage);
		return result;
	};
	const oldestDays = async () => spend(await store.readOldestDays(network)).oldest;
	/** Deletes the day of `expiry`, if any. The day when rows were deleted, else null. */
	const deleteDay = async (
		expiry: Expiry,
		remove: (day: UtcDay) => ReturnType<Store["deleteRawDay"]>,
	): Promise<UtcDay | null> =>
		expiry.day !== null && spend(await remove(expiry.day)).deleted ? expiry.day : null;

	const before = await oldestDays();
	const figures = spend(
		await store.writeDailyFigures(
			network,
			figureCandidates(before.probes, nowMs),
			FIGURES_DAYS_PER_RUN,
		),
	);
	const probes = expiryOf(earlierDay(before.probes, before.ticks), retention.probeDays, nowMs);
	const probesDayDeleted = await deleteDay(probes, (day) => store.deleteProbeDay(network, day));
	const after = await oldestDays();
	const raw = expiryOf(after.raw, retention.rawDays, nowMs);
	const rawDayDeleted = await deleteDay(raw, (day) => store.deleteRawDay(network, day));
	const old = expiryOf(after.figures, retention.dailyDays, nowMs);
	const figuresDayDeleted = await deleteDay(old, (day) => store.deleteFiguresDay(network, day));

	const left = (expiry: Expiry, deleted: UtcDay | null) =>
		expiry.waiting - (deleted === null ? 0 : 1);
	const run: MaintenanceRun = {
		event: "maintenance",
		figuresDays: figures.days,
		probesDayDeleted,
		rawDayDeleted,
		figuresDayDeleted,
		backlogDays: Math.max(
			left(probes, probesDayDeleted),
			left(raw, rawDayDeleted),
			left(old, figuresDayDeleted),
		),
		databaseBytes: usage.at(-1)?.databaseBytes ?? 0,
		rowsRead: usage.reduce((sum, step) => sum + step.rowsRead, 0),
		rowsWritten: usage.reduce((sum, step) => sum + step.rowsWritten, 0),
	};
	console.info(run);
	if (run.backlogDays > 0) {
		console.warn({
			event: "maintenance_backlog",
			days: run.backlogDays,
			waiting: { probes: probes.waiting, raw: raw.waiting, figures: old.waiting },
		});
	}
	return run;
}
