/**
 * Domain model for Corridor Weather.
 *
 * Every module in `src/domain` is pure: no I/O, no clock, no globals. External
 * data becomes these types exactly once, in `src/gateway` (network) and
 * `src/worker/config.ts` (environment).
 */

import type { Sha256Hex } from "./schedule";

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** CAIP-2 chain id exactly as the gateway keys it in `/v1/defaults`. */
export type ChainId = Brand<string, "ChainId">;
/** CAIP-19 asset id, `{chainId}/{standard}:{address}`. */
export type AssetId = Brand<string, "AssetId">;
/** `{sourceAssetId}>{destinationAssetId}`. */
export type CorridorId = Brand<string, "CorridorId">;
/** Non-negative integer in the token's smallest unit, digits only. */
export type AtomicAmount = Brand<string, "AtomicAmount">;
/** ISO 8601 UTC timestamp with millisecond precision. */
export type IsoTimestamp = Brand<string, "IsoTimestamp">;
/** The probe's `request_id`: `[A-Za-z0-9._-]{1,128}`, stable for one (slot, target). */
export type ProbeId = Brand<string, "ProbeId">;

export type Network = "testnet" | "mainnet";

export const AMOUNT_TIERS = ["small", "typical", "large"] as const;
export type AmountTier = (typeof AMOUNT_TIERS)[number];

export type ChainNamespace = "eip155" | "solana" | "tron";

export interface Asset {
	readonly id: AssetId;
	readonly chainId: ChainId;
	readonly namespace: ChainNamespace;
	readonly symbol: string;
	readonly decimals: number;
}

export interface Corridor {
	readonly id: CorridorId;
	readonly source: Asset;
	readonly destination: Asset;
}

/** One unit of probe work: a corridor at one amount tier. */
export interface ProbeTarget {
	readonly corridor: Corridor;
	readonly tier: AmountTier;
	/** Amount delivered at the destination, in destination-token atomic units. */
	readonly fulfillmentAmount: AtomicAmount;
}

/**
 * A scheduling slot. `index` is `floor(epochMs / intervalMs)`, so a retried or
 * duplicated cron invocation maps to the same slot and the same probe ids.
 */
export interface TickSlot {
	readonly network: Network;
	readonly index: number;
	readonly start: IsoTimestamp;
}

/** Keyless accounts that tag probe traffic. One per chain namespace. */
export type ProbeIdentity = Readonly<Record<ChainNamespace, string>>;

export interface QuoteObservation {
	readonly quoteId: string;
	readonly settlerAddress: string;
	/** What would leave the source account, in source-token atomic units. */
	readonly sourceAmount: AtomicAmount;
	readonly awardDeadline: IsoTimestamp;
	/**
	 * Price over face value in basis points. `null` when the two tokens do not
	 * share a peg, because a spread against face value is then meaningless.
	 */
	readonly spreadBps: number | null;
	/**
	 * `awardDeadline` minus the time the quote was first observed. Null when the
	 * probe did not observe it arrive, as for a replayed batch.
	 */
	readonly priceHoldMs: number | null;
}

export interface DeclineEntry {
	/** Open set. The gateway adds reasons over time. `OTHER` when the gateway sent no publishable code. */
	readonly reason: string;
	/** `RETRY_AFTER_DELAY`, `NOT_RETRYABLE_FIX_REQUEST`, `CONTACT_SUPPORT`, or absent. */
	readonly retryClassification: string | null;
	readonly count: number;
}

export type ProbePhase = "create" | "poll";

/**
 * What one probe saw. Each variant carries only the fields that exist for it,
 * so a `declined` probe cannot hold quotes and a `quoted` probe always has one.
 */
export type ProbeOutcome =
	| {
			readonly kind: "quoted";
			readonly quotes: readonly [QuoteObservation, ...QuoteObservation[]];
			readonly declines: readonly DeclineEntry[];
			readonly requestedCount: number | null;
	  }
	| {
			readonly kind: "declined";
			readonly declines: readonly [DeclineEntry, ...DeclineEntry[]];
			readonly requestedCount: number | null;
	  }
	| {
			/** The window closed with no quote and no decline. */
			readonly kind: "silent";
			readonly requestedCount: number | null;
	  }
	| {
			/** The poll budget ran out while the batch was still `collecting`. */
			readonly kind: "incomplete";
	  }
	| {
			readonly kind: "gateway_error";
			readonly phase: ProbePhase;
			/** Absent for transport failures and timeouts. */
			readonly httpStatus: number | null;
			/** The gateway's public error code, when the body carried one. */
			readonly code: string | null;
			readonly message: string;
	  };

export type ProbeOutcomeKind = ProbeOutcome["kind"];

export interface ProbeTimings {
	/** Round trip of `POST /v1/payments/quote-requests`. */
	readonly createLatencyMs: number | null;
	/** From sending the create call to the first poll that listed a quote. */
	readonly firstQuoteMs: number | null;
	/** From sending the create call to the first poll that returned `ready`. */
	readonly readyMs: number | null;
}

/** One HTTP exchange with the gateway, kept verbatim for later recomputation. */
export interface RawExchange {
	readonly at: IsoTimestamp;
	readonly method: "GET" | "POST";
	readonly path: string;
	readonly requestBody: unknown | null;
	readonly status: number | null;
	readonly latencyMs: number;
	/**
	 * The body text exactly as the gateway sent it. Null when no body was read:
	 * the request was refused or failed, or the body was over the size cap.
	 * Never re-serialized from parsed JSON, whose depth the gateway controls.
	 */
	readonly responseBody: string | null;
	readonly error: string | null;
}

export interface ProbeRecord {
	readonly id: ProbeId;
	readonly slot: TickSlot;
	readonly target: ProbeTarget;
	readonly startedAt: IsoTimestamp;
	readonly quoteRequestId: string | null;
	/** True when the gateway resolved the id onto a batch that already existed. */
	readonly idempotentReplay: boolean;
	readonly outcome: ProbeOutcome;
	readonly timings: ProbeTimings;
	readonly raw: readonly RawExchange[];
}

/** The result of one scheduled run. */
export interface TickRecord {
	readonly slot: TickSlot;
	readonly startedAt: IsoTimestamp;
	readonly finishedAt: IsoTimestamp;
	/** Corridors discovered from `/v1/defaults` this tick. Empty when discovery failed. */
	readonly corridors: readonly Corridor[];
	/** SHA-256 of `corridorListText(corridors)`. Null when discovery failed. */
	readonly corridorsHash: Sha256Hex | null;
	readonly planned: number;
	/** Targets left out because a tier amount has more fractional digits than the destination token. */
	readonly unrepresentable: number;
	readonly probes: readonly ProbeRecord[];
	/** Set when the tick stopped before the plan was done. */
	readonly aborted: TickAbort | null;
}

export type TickAbort =
	| { readonly reason: "defaults_unavailable"; readonly message: string }
	| { readonly reason: "rate_limited"; readonly message: string }
	/** The Workers platform refused a request for passing the subrequest limit. */
	| { readonly reason: "subrequest_limit"; readonly message: string }
	| { readonly reason: "disabled"; readonly message: string };
