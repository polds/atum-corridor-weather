import { compareText, isAssetId, isChainId, isCorridorId, namespaceOf } from "./brands";
import type { Asset, ChainId, ChainNamespace, Corridor } from "./types";

export interface ListedToken {
	readonly address: string;
	readonly decimals: number;
	readonly symbol: string;
}

/** One chain of `GET /v1/defaults`, with the fields a quote request needs. */
export interface ListedChain {
	readonly escrow_contract: string;
	readonly quote_selector: string;
	readonly fulfillment_proxy: string;
	readonly fulfillment_verifier: { readonly account: string; readonly endpoint: string };
	readonly tokens: readonly ListedToken[];
}

/** `GET /v1/defaults` with no `chain_id`, keyed by chain id exactly as the gateway spells it. */
export type DefaultsListing = Readonly<Record<string, ListedChain>>;

export interface Discovery {
	readonly assets: readonly Asset[];
	readonly corridors: readonly Corridor[];
}

const TOKEN_STANDARD: Readonly<Record<ChainNamespace, string>> = {
	eip155: "erc20",
	tron: "trc20",
	solana: "token",
};

/**
 * A chain is probed only when a quote request can be built for it: a known
 * namespace, every address the request body copies, and at least one token.
 */
function isProbeable(chain: ListedChain): boolean {
	return (
		chain.escrow_contract !== "" &&
		chain.quote_selector !== "" &&
		chain.fulfillment_proxy !== "" &&
		chain.fulfillment_verifier.account !== "" &&
		chain.fulfillment_verifier.endpoint !== "" &&
		chain.tokens.length > 0
	);
}

/** EVM addresses are case-insensitive, so the SDK and the asset id use lower case. Base58 is not. */
function canonicalAddress(namespace: ChainNamespace, address: string): string {
	return namespace === "eip155" ? address.toLowerCase() : address;
}

function assetsOf(chainId: ChainId, namespace: ChainNamespace, chain: ListedChain): Asset[] {
	return chain.tokens.flatMap((token) => {
		const id = `${chainId}/${TOKEN_STANDARD[namespace]}:${canonicalAddress(namespace, token.address)}`;
		if (!isAssetId(id)) return [];
		return [{ id, chainId, namespace, symbol: token.symbol, decimals: token.decimals }];
	});
}

export function listAssets(listing: DefaultsListing): Asset[] {
	const byId = new Map<string, Asset>();
	for (const [key, chain] of Object.entries(listing)) {
		if (!isChainId(key) || !isProbeable(chain)) continue;
		const namespace = namespaceOf(key);
		if (namespace === null) continue;
		for (const asset of assetsOf(key, namespace, chain)) {
			if (!byId.has(asset.id)) byId.set(asset.id, asset);
		}
	}
	return [...byId.values()].sort((a, b) => compareText(a.id, b.id));
}

/** The text `CORRIDOR_FILTER` is matched against. */
export function corridorLabel(source: Asset, destination: Asset): string {
	return `${source.chainId}/${source.symbol}>${destination.chainId}/${destination.symbol}`;
}

/**
 * The text the corridor list's hash covers: each corridor id with the symbol and
 * decimals of both assets, sorted by id. That is every column of a corridors row
 * except its times, so two lists with the same text store the same rows.
 */
export function corridorListText(corridors: readonly Corridor[]): string {
	return JSON.stringify(
		[...corridors]
			.sort((a, b) => compareText(a.id, b.id))
			.map(({ id, source, destination }) => [
				id,
				source.symbol,
				source.decimals,
				destination.symbol,
				destination.decimals,
			]),
	);
}

/** Every ordered pair of distinct assets, sorted by corridor id. */
export function discoverCorridors(listing: DefaultsListing, filter: RegExp | null): Discovery {
	const assets = listAssets(listing);
	const corridors: Corridor[] = [];
	for (const source of assets) {
		for (const destination of assets) {
			if (source.id === destination.id) continue;
			if (filter !== null && !filter.test(corridorLabel(source, destination))) continue;
			const id = `${source.id}>${destination.id}`;
			if (isCorridorId(id)) corridors.push({ id, source, destination });
		}
	}
	corridors.sort((a, b) => compareText(a.id, b.id));
	return { assets, corridors };
}
