import type {
	AssetId,
	AtomicAmount,
	ChainId,
	ChainNamespace,
	CorridorId,
	IsoTimestamp,
	ProbeId,
} from "./types";

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ATOMIC = /^\d{1,78}$/;
const PROBE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const CHAIN_ID = /^([-a-z0-9]{3,8}):[-_a-zA-Z0-9]{1,32}$/;
const ASSET_ID = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}\/[-a-z0-9]{3,8}:[-.%a-zA-Z0-9]{1,128}$/;
const NAMESPACES: readonly ChainNamespace[] = ["eip155", "solana", "tron"];

export function isIsoTimestamp(value: string): value is IsoTimestamp {
	return ISO_MS.test(value) && !Number.isNaN(Date.parse(value));
}

export function isAtomicAmount(value: string): value is AtomicAmount {
	return ATOMIC.test(value);
}

export function isProbeId(value: string): value is ProbeId {
	return PROBE_ID.test(value);
}

export function isChainId(value: string): value is ChainId {
	return CHAIN_ID.test(value);
}

export function isAssetId(value: string): value is AssetId {
	return ASSET_ID.test(value);
}

export function isCorridorId(value: string): value is CorridorId {
	const parts = value.split(">");
	return parts.length === 2 && parts.every(isAssetId);
}

/** The namespace of a CAIP-2 chain id, or null when Corridor Weather does not probe it. */
export function namespaceOf(chainId: ChainId): ChainNamespace | null {
	const prefix = chainId.slice(0, chainId.indexOf(":"));
	return NAMESPACES.find((namespace) => namespace === prefix) ?? null;
}

/** Throws only for an epoch outside the four-digit-year range. */
export function isoAt(epochMs: number): IsoTimestamp {
	const iso = new Date(epochMs).toISOString();
	if (!isIsoTimestamp(iso)) throw new RangeError(`${epochMs} has no four-digit-year timestamp`);
	return iso;
}

/** Any timestamp `Date.parse` accepts, normalized to millisecond UTC. */
export function toIsoTimestamp(value: string): IsoTimestamp | null {
	const ms = Date.parse(value);
	if (Number.isNaN(ms)) return null;
	const iso = new Date(ms).toISOString();
	return isIsoTimestamp(iso) ? iso : null;
}

/** Code-unit order, independent of locale. */
export function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
