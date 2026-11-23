import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { isoAt } from "../../src/domain/brands";
import type { Alert, Snapshot } from "../../src/domain/snapshot";
import { createStore } from "../../src/store/store";
import { clearTables } from "../support/db";

const GENERATED_AT = isoAt(Date.UTC(2026, 10, 22, 10, 35));

function snapshotWith(alerts: readonly Alert[]): Snapshot {
	return {
		schemaVersion: 1,
		network: "testnet",
		generatedAt: GENERATED_AT,
		tickIntervalMinutes: 5,
		publishIntervalMinutes: 5,
		cadence: { probesPerTick: 30, sweepHours: 4.6 },
		tiers: ["small", "typical", "large"],
		lastTick: null,
		assets: [],
		corridors: [],
		alerts,
	};
}

function alerts(count: number, message: string): Alert[] {
	return Array.from({ length: count }, () => ({
		kind: "slow_quotes",
		severity: "warning",
		corridorId: null,
		message,
		since: GENERATED_AT,
	}));
}

describe("the stored snapshot", () => {
	beforeEach(clearTables);

	it("reads back a 5 MB snapshot exactly as it was saved", async () => {
		const store = createStore(env.DB);
		const large = snapshotWith(alerts(5000, "x".repeat(1000)));
		const json = JSON.stringify(large);
		expect(json.length).toBeGreaterThan(5_000_000);

		await store.saveSnapshot(large);

		expect(await store.readSnapshotJson("testnet")).toBe(json);
		expect(await store.readSnapshot("testnet")).toEqual(large);
	});

	it("keeps characters outside the basic plane whole across a part boundary", async () => {
		const store = createStore(env.DB);
		// The two paddings put a part boundary on each half of a surrogate pair.
		for (const padding of ["", "a"]) {
			const astral = snapshotWith(alerts(3000, padding + "🌩".repeat(200)));

			await store.saveSnapshot(astral);

			expect(await store.readSnapshotJson("testnet")).toBe(JSON.stringify(astral));
		}
	});

	it("leaves no part of a larger snapshot behind when a smaller one replaces it", async () => {
		const store = createStore(env.DB);
		await store.saveSnapshot(snapshotWith(alerts(5000, "x".repeat(1000))));
		const small = snapshotWith([]);

		await store.saveSnapshot(small);

		expect(await store.readSnapshotJson("testnet")).toBe(JSON.stringify(small));
	});

	it("reads a snapshot saved before publishIntervalMinutes existed as published every tick", async () => {
		const { publishIntervalMinutes: _, ...older } = snapshotWith([]);
		await env.DB.prepare(
			"INSERT INTO snapshots (network, part, generated_at, snapshot_json) VALUES (?1, 0, ?2, ?3)",
		)
			.bind("testnet", GENERATED_AT, JSON.stringify({ ...older, tickIntervalMinutes: 7 }))
			.run();

		expect(await createStore(env.DB).readSnapshot("testnet")).toMatchObject({
			tickIntervalMinutes: 7,
			publishIntervalMinutes: 7,
		});
	});

	it("reads no snapshot before one is saved", async () => {
		const store = createStore(env.DB);

		expect(await store.readSnapshotJson("testnet")).toBeNull();
		expect(await store.readSnapshot("testnet")).toBeNull();
	});
});
