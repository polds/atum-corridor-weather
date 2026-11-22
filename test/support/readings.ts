import { isAtomicAmount, isCorridorId, isIsoTimestamp } from "../../src/domain/brands";
import type { SnapshotTick, TierReading } from "../../src/domain/snapshot";
import type {
	AmountTier,
	AtomicAmount,
	CorridorId,
	IsoTimestamp,
	ProbeOutcomeKind,
} from "../../src/domain/types";

export function iso(text: string): IsoTimestamp {
	if (!isIsoTimestamp(text)) throw new Error(`not an ISO timestamp: ${text}`);
	return text;
}

export function atomic(text: string): AtomicAmount {
	if (!isAtomicAmount(text)) throw new Error(`not an atomic amount: ${text}`);
	return text;
}

export function corridorId(text: string): CorridorId {
	if (!isCorridorId(text)) throw new Error(`not a corridor id: ${text}`);
	return text;
}

export function reading(
	tier: AmountTier,
	outcome: ProbeOutcomeKind,
	probedAt: string,
	extra: Partial<TierReading> = {},
): TierReading {
	const quoted = outcome === "quoted";
	return {
		tier,
		fulfillmentAmount: atomic("1000000"),
		probedAt: iso(probedAt),
		outcome,
		quoteCount: quoted ? 1 : 0,
		operatorCount: quoted ? 1 : 0,
		bestSourceAmount: null,
		bestSpreadBps: quoted ? 2 : null,
		worstSpreadBps: quoted ? 2 : null,
		firstQuoteMs: quoted ? 600 : null,
		readyMs: null,
		minPriceHoldMs: null,
		declines: [],
		...extra,
	};
}

export function tick(slotStart: string, extra: Partial<SnapshotTick> = {}): SnapshotTick {
	const finished = new Date(Date.parse(slotStart) + 60_000).toISOString();
	return {
		slotStart: iso(slotStart),
		finishedAt: iso(finished),
		planned: 4,
		completed: 4,
		gatewayErrors: 0,
		aborted: null,
		...extra,
	};
}
