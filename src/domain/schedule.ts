import { toAtomicAmount } from "./amounts";
import { compareText, isoAt, isProbeId } from "./brands";
import {
	AMOUNT_TIERS,
	type AmountTier,
	type Brand,
	type Corridor,
	type IsoTimestamp,
	type Network,
	type ProbeId,
	type ProbeTarget,
	type TickSlot,
} from "./types";

/** Whole-token amount per tier. A tier left out is not probed. */
export type TierAmounts = Readonly<Partial<Record<AmountTier, string>>>;

/** Lower-case hex SHA-256 of a corridor id or list. Computed at the boundary, where hashing is async. */
export type Sha256Hex = Brand<string, "Sha256Hex">;

export function isSha256Hex(value: string): value is Sha256Hex {
	return /^[0-9a-f]{64}$/.test(value);
}

export function slotAt(params: {
	readonly network: Network;
	readonly epochMs: number;
	readonly intervalMinutes: number;
}): TickSlot {
	const intervalMs = params.intervalMinutes * 60_000;
	const index = Math.floor(params.epochMs / intervalMs);
	return { network: params.network, index, start: isoAt(index * intervalMs) };
}

/** Every corridor at every configured tier, ordered by corridor id, then tier. */
export function probeTargets(corridors: readonly Corridor[], tiers: TierAmounts): ProbeTarget[] {
	return [...corridors]
		.sort((a, b) => compareText(a.id, b.id))
		.flatMap((corridor) =>
			AMOUNT_TIERS.flatMap((tier) => {
				const whole = tiers[tier];
				const amount =
					whole === undefined ? null : toAtomicAmount(whole, corridor.destination.decimals);
				return amount === null ? [] : [{ corridor, tier, fulfillmentAmount: amount }];
			}),
		);
}

/**
 * Requests a tick leaves unused. The plan counts the calls the Worker makes to
 * the gateway. This room is for anything Cloudflare counts that the plan does
 * not, so that a tick never ends on the last request the limit allows.
 */
export const SUBREQUEST_RESERVE = 6;

/**
 * The probes one tick may plan: `probesPerTick`, or as many whole probes as fit
 * in `subrequestLimit` after the one request that reads `/v1/defaults`,
 * whichever is smaller. Zero means not even one probe fits.
 */
export function probesPlannedPerTick(params: {
	readonly probesPerTick: number;
	readonly subrequestLimit: number;
	readonly requestsPerProbe: number;
}): number {
	const affordable = Math.floor(
		(params.subrequestLimit - 1 - SUBREQUEST_RESERVE) / params.requestsPerProbe,
	);
	return Math.max(0, Math.min(params.probesPerTick, affordable));
}

/**
 * The targets slot `slot.index` probes: `probesPlanned` of them from offset
 * `slot.index * probesPlanned mod total`, wrapping around, each at most once.
 * Pass the planned number, not `PROBES_PER_TICK`, or a capped tick skips targets.
 */
export function batchFor(
	slot: TickSlot,
	targets: readonly ProbeTarget[],
	probesPlanned: number,
): ProbeTarget[] {
	if (targets.length === 0) return [];
	const offset = (slot.index * probesPlanned) % targets.length;
	return [...targets.slice(offset), ...targets.slice(0, offset)].slice(0, probesPlanned);
}

/** `20261122T1035Z` from `2026-11-22T10:35:00.000Z`. */
function compactMinute(start: IsoTimestamp): string {
	return `${start.slice(0, 4)}${start.slice(5, 7)}${start.slice(8, 10)}T${start.slice(11, 13)}${start.slice(14, 16)}Z`;
}

/** `cw1.{network}.{slot start}.{first 12 hex of the corridor digest}.{tier}`. */
export function probeIdFor(params: {
	readonly slot: TickSlot;
	readonly tier: AmountTier;
	readonly corridorDigest: Sha256Hex;
}): ProbeId {
	const { slot, tier, corridorDigest } = params;
	const id = `cw1.${slot.network}.${compactMinute(slot.start)}.${corridorDigest.slice(0, 12)}.${tier}`;
	if (!isProbeId(id)) throw new RangeError(`not a valid request_id: ${id}`);
	return id;
}
