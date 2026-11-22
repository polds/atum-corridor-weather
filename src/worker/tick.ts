import { isoAt } from "../domain/brands";
import { discoverCorridors } from "../domain/corridors";
import { PROBE_IDENTITY } from "../domain/identity";
import { buildSnapshot } from "../domain/publish";
import {
	batchFor,
	isSha256Hex,
	probeIdFor,
	probeTargets,
	type Sha256Hex,
	slotAt,
} from "../domain/schedule";
import type { Snapshot } from "../domain/snapshot";
import type { ProbeRecord, TickRecord, TickSlot } from "../domain/types";
import type { GatewayClient, GatewayFailure } from "../gateway/client";
import { isRateLimited, runProbe } from "../gateway/probe";
import type { Store } from "../store/store";
import type { Config } from "./config";

export interface TickDeps {
	readonly config: Config;
	readonly gateway: GatewayClient;
	readonly store: Store;
	/** Epoch ms. */
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
}

type TickRun = Pick<TickRecord, "corridors" | "planned" | "probes" | "aborted">;

const DAY_MS = 86_400_000;

async function sha256Hex(text: string): Promise<Sha256Hex> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	const hex = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	if (!isSha256Hex(hex)) throw new Error(`SHA-256 produced ${hex}`);
	return hex;
}

function describeFailure(failure: GatewayFailure): string {
	switch (failure.kind) {
		case "http":
			return `HTTP ${failure.status}${failure.code === null ? "" : ` ${failure.code}`}: ${failure.message}`;
		case "invalid_response":
			return `HTTP ${failure.status}: ${failure.message}`;
		default:
			return `${failure.kind}: ${failure.message}`;
	}
}

async function probeSlot(deps: TickDeps, slot: TickSlot): Promise<TickRun> {
	const { config } = deps;
	if (!config.probeEnabled) {
		return {
			corridors: [],
			planned: 0,
			probes: [],
			aborted: { reason: "disabled", message: "PROBE_ENABLED is false" },
		};
	}
	const defaults = await deps.gateway.getDefaults();
	if (!defaults.ok) {
		return {
			corridors: [],
			planned: 0,
			probes: [],
			aborted: { reason: "defaults_unavailable", message: describeFailure(defaults.failure) },
		};
	}
	const { corridors } = discoverCorridors(defaults.value, config.corridorFilter);
	const batch = batchFor(slot, probeTargets(corridors, config.tierAmounts), config.probesPerTick);
	const probes: ProbeRecord[] = [];
	for (const target of batch) {
		const corridorDigest = await sha256Hex(target.corridor.id);
		const probe = await runProbe(
			{
				id: probeIdFor({ slot, tier: target.tier, corridorDigest }),
				slot,
				target,
				listing: defaults.value,
				identity: PROBE_IDENTITY,
			},
			{
				gateway: deps.gateway,
				now: deps.now,
				sleep: deps.sleep,
				pollIntervalMs: config.pollIntervalMs,
				quoteWindowSeconds: config.quoteWindowSeconds,
			},
		);
		probes.push(probe);
		if (isRateLimited(probe.outcome)) {
			return {
				corridors,
				planned: batch.length,
				probes,
				aborted: {
					reason: "rate_limited",
					message: `the gateway answered 429 to ${probe.id}; ${batch.length - probes.length} probes skipped`,
				},
			};
		}
	}
	return { corridors, planned: batch.length, probes, aborted: null };
}

/** Rebuilds the public snapshot from the store and stores it. */
export async function publishSnapshot(
	deps: Pick<TickDeps, "config" | "store" | "now">,
): Promise<Snapshot> {
	const { config } = deps;
	const source = await deps.store.readSnapshotSource(config.network);
	const snapshot = buildSnapshot({
		network: config.network,
		nowMs: deps.now(),
		tickIntervalMinutes: config.tickIntervalMinutes,
		probesPerTick: config.probesPerTick,
		slowQuoteMs: config.slowQuoteMs,
		tierAmounts: config.tierAmounts,
		...source,
	});
	await deps.store.saveSnapshot(snapshot);
	return snapshot;
}

/**
 * One scheduled run: discover corridors, probe this slot's batch one target at
 * a time, store everything, then publish the snapshot. A failed discovery is
 * stored as an aborted tick and the snapshot is still rebuilt.
 */
export async function runTick(deps: TickDeps, scheduledTimeMs: number): Promise<TickRecord> {
	const { config } = deps;
	const slot = slotAt({
		network: config.network,
		epochMs: scheduledTimeMs,
		intervalMinutes: config.tickIntervalMinutes,
	});
	const startedAt = isoAt(deps.now());
	const run = await probeSlot(deps, slot);
	const finishedMs = deps.now();
	const tick: TickRecord = { slot, startedAt, finishedAt: isoAt(finishedMs), ...run };
	await deps.store.saveTick(tick, {
		dropRawBefore:
			config.rawRetentionDays === 0 ? null : isoAt(finishedMs - config.rawRetentionDays * DAY_MS),
	});
	await publishSnapshot(deps);
	return tick;
}
