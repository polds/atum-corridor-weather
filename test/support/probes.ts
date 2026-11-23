import { env } from "cloudflare:workers";
import { isoAt } from "../../src/domain/brands";
import { corridorListText } from "../../src/domain/corridors";
import { isSha256Hex, probeIdFor, type Sha256Hex, slotAt } from "../../src/domain/schedule";
import type {
	AmountTier,
	Corridor,
	DeclineEntry,
	ProbeOutcome,
	ProbeRecord,
	RawExchange,
} from "../../src/domain/types";
import type { Store } from "../../src/store/store";
import { ARB_TO_BASE_USDC, corridorById, testnetCorridors } from "./fixtures";
import { atomic, iso } from "./readings";

async function sha256(text: string): Promise<Sha256Hex> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	const hex = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	if (!isSha256Hex(hex)) throw new Error(hex);
	return hex;
}

const corridorsHash = sha256(corridorListText(testnetCorridors));

/** One probe as a test describes it. Everything but the outcome has a default. */
export interface ProbeSpec {
	readonly outcome: ProbeOutcome;
	readonly corridor?: Corridor;
	readonly tier?: AmountTier;
	readonly firstQuoteMs?: number | null;
	readonly raw?: readonly RawExchange[];
}

/** A quoted outcome with one quote per entry: its operator and its spread. */
export function quotedBy(
	quotes: readonly { operator: string; spreadBps: number | null }[],
): ProbeOutcome {
	const observations = quotes.map((quote, index) => ({
		quoteId: `q-${index}`,
		settlerAddress: quote.operator,
		sourceAmount: atomic(String(1_000_000 + index)),
		awardDeadline: iso("2026-11-22T11:56:00.000Z"),
		spreadBps: quote.spreadBps,
		priceHoldMs: 60_000,
	}));
	const [first, ...rest] = observations;
	if (first === undefined) throw new Error("a quoted probe needs a quote");
	return { kind: "quoted", quotes: [first, ...rest], declines: [], requestedCount: 3 };
}

export function declinedFor(
	declines: readonly Omit<DeclineEntry, "retryClassification">[],
): ProbeOutcome {
	const [first, ...rest] = declines.map((decline) => ({ ...decline, retryClassification: null }));
	if (first === undefined) throw new Error("a declined probe needs a decline");
	return { kind: "declined", declines: [first, ...rest], requestedCount: 3 };
}

export const QUOTED: ProbeOutcome = quotedBy([{ operator: "0xa1", spreadBps: 2 }]);

/**
 * Stores one tick of `probes` through the store, as a tick would, in the
 * 2-minute slot that starts at `slotStart`, with the testnet corridor list.
 * Probes of one tick must differ in corridor or tier.
 */
export async function storeTick(
	store: Store,
	slotStart: string,
	probes: readonly ProbeSpec[],
): Promise<ProbeRecord[]> {
	const slot = slotAt({ network: "testnet", epochMs: Date.parse(slotStart), intervalMinutes: 2 });
	if (slot.start !== slotStart) throw new Error(`${slotStart} does not start a 2-minute slot`);
	const startMs = Date.parse(slot.start);
	const records = await Promise.all(
		probes.map(async (spec, index): Promise<ProbeRecord> => {
			const corridor = spec.corridor ?? corridorById(ARB_TO_BASE_USDC);
			const tier = spec.tier ?? "small";
			return {
				id: probeIdFor({ slot, tier, corridorDigest: await sha256(corridor.id) }),
				slot,
				target: { corridor, tier, fulfillmentAmount: atomic("1000000") },
				startedAt: isoAt(startMs + 1000 + index * 4000),
				quoteRequestId: `qr-${index}`,
				idempotentReplay: false,
				outcome: spec.outcome,
				timings: {
					createLatencyMs: 60,
					firstQuoteMs:
						spec.firstQuoteMs === undefined
							? spec.outcome.kind === "quoted"
								? 600
								: null
							: spec.firstQuoteMs,
					readyMs: null,
				},
				raw: spec.raw ?? [],
			};
		}),
	);
	await store.saveTick({
		slot,
		startedAt: isoAt(startMs + 500),
		finishedAt: isoAt(startMs + 1000 + records.length * 4000),
		corridors: testnetCorridors,
		corridorsHash: await corridorsHash,
		planned: records.length,
		unrepresentable: 0,
		probes: records,
		aborted: null,
	});
	return records;
}

export async function count(table: string): Promise<number> {
	const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first("n");
	return typeof row === "number" ? row : -1;
}
