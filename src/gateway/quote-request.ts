/**
 * Builds the `POST /v1/payments/quote-requests` body as SDK 6.0.0's
 * `prepareQuoteRequest` does, without the SDK. The SDK stays out of the Worker
 * and checks this builder in `test/node/quote-request.sdk-conformance.test.ts`.
 */
import { isoAt } from "../domain/brands";
import type { DefaultsListing, ListedChain } from "../domain/corridors";
import type {
	AssetId,
	AtomicAmount,
	ChainId,
	ChainNamespace,
	IsoTimestamp,
	ProbeId,
	ProbeIdentity,
	ProbeTarget,
} from "../domain/types";

/** The SDK's `PAYMENT_REQUEST_VERSION`. */
export const QUOTE_REQUEST_VERSION = "1.3";

/** The SDK's `DEFAULT_FULFILLMENT_DEADLINE_SECONDS`. */
export const DEFAULT_FULFILLMENT_WINDOW_SECONDS = 300;

interface OwnedAsset {
	readonly asset_identifier: AssetId;
	readonly account: string;
}

/** The body Corridor Weather sends. It has no spend cap and cannot carry `sender_auth`. */
export interface QuoteRequestBody {
	readonly version: typeof QUOTE_REQUEST_VERSION;
	readonly request_id: ProbeId;
	readonly source: OwnedAsset;
	readonly destination: readonly [OwnedAsset];
	readonly fulfillment_amount: AtomicAmount;
	readonly quote_deadline: IsoTimestamp;
	readonly fulfillment_deadline: IsoTimestamp;
	readonly escrow_contract_address: string;
	readonly quote_selector: string;
	readonly fulfillment_verifier: { readonly account: string; readonly endpoint: string };
	readonly fulfillment_proxy: string;
	readonly sender_auth?: never;
}

export type QuoteRequestError =
	| { readonly kind: "chain_not_listed"; readonly chainId: ChainId }
	| { readonly kind: "invalid_tron_address"; readonly address: string }
	| { readonly kind: "selector_is_gateway_selector"; readonly selector: string };

export type QuoteRequestBuild =
	| { readonly ok: true; readonly body: QuoteRequestBody }
	| { readonly ok: false; readonly error: QuoteRequestError };

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Value(text: string): bigint | null {
	let value = 0n;
	for (const char of text) {
		const digit = BASE58_ALPHABET.indexOf(char);
		if (digit === -1) return null;
		value = value * 58n + BigInt(digit);
	}
	return value;
}

/**
 * A Tron account as lower-case `0x` hex of its 20-byte body, as the SDK's
 * Tron adapter writes `quote_selector` and the verifier account. A base58check
 * T-address is decoded and loses its `0x41` prefix and checksum; the checksum
 * is not verified.
 */
function tronHex(address: string): string | null {
	let hex = address.replace(/^0x/, "");
	if (address.startsWith("T")) {
		const value = base58Value(address);
		const full = value?.toString(16).padStart(50, "0") ?? "";
		if (full.length !== 50 || !full.startsWith("41")) return null;
		hex = full.slice(2, 42);
	} else if (hex.length === 42 && hex.startsWith("41")) {
		hex = hex.slice(2);
	}
	return /^[0-9a-fA-F]{40}$/.test(hex) ? `0x${hex.toLowerCase()}` : null;
}

function sameAccount(namespace: ChainNamespace, a: string, b: string): boolean {
	return namespace === "eip155" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function buildQuoteRequest(params: {
	readonly target: ProbeTarget;
	readonly sourceChain: ListedChain;
	readonly destinationChain: ListedChain;
	readonly identity: ProbeIdentity;
	readonly requestId: ProbeId;
	readonly nowMs: number;
	readonly quoteWindowSeconds: number;
	readonly fulfillmentWindowSeconds?: number;
}): QuoteRequestBuild {
	const { target, sourceChain, destinationChain, identity, nowMs } = params;
	const { source, destination } = target.corridor;
	const depositor = identity[source.namespace];
	let selector = depositor;
	let gatewaySelector = sourceChain.quote_selector;
	let verifierAccount = sourceChain.fulfillment_verifier.account;
	if (source.namespace === "tron") {
		const own = tronHex(selector);
		const gateway = tronHex(gatewaySelector);
		const verifier = tronHex(verifierAccount);
		if (own === null || gateway === null || verifier === null) {
			const address =
				own === null ? selector : gateway === null ? gatewaySelector : verifierAccount;
			return { ok: false, error: { kind: "invalid_tron_address", address } };
		}
		selector = own;
		gatewaySelector = gateway;
		verifierAccount = verifier;
	}
	if (sameAccount(source.namespace, selector, gatewaySelector)) {
		return { ok: false, error: { kind: "selector_is_gateway_selector", selector } };
	}
	const fulfillmentWindowSeconds =
		params.fulfillmentWindowSeconds ?? DEFAULT_FULFILLMENT_WINDOW_SECONDS;
	return {
		ok: true,
		body: {
			version: QUOTE_REQUEST_VERSION,
			request_id: params.requestId,
			source: { asset_identifier: source.id, account: depositor },
			destination: [{ asset_identifier: destination.id, account: identity[destination.namespace] }],
			fulfillment_amount: target.fulfillmentAmount,
			quote_deadline: isoAt(nowMs + params.quoteWindowSeconds * 1000),
			fulfillment_deadline: isoAt(nowMs + fulfillmentWindowSeconds * 1000),
			escrow_contract_address: sourceChain.escrow_contract,
			quote_selector: selector,
			fulfillment_verifier: {
				account: verifierAccount,
				endpoint: sourceChain.fulfillment_verifier.endpoint,
			},
			fulfillment_proxy: destinationChain.fulfillment_proxy,
		},
	};
}

/** `buildQuoteRequest` with both chains looked up in the listing the tick discovered from. */
export function buildQuoteRequestFromListing(
	params: Omit<Parameters<typeof buildQuoteRequest>[0], "sourceChain" | "destinationChain"> & {
		readonly listing: DefaultsListing;
	},
): QuoteRequestBuild {
	const { source, destination } = params.target.corridor;
	const sourceChain = params.listing[source.chainId];
	const destinationChain = params.listing[destination.chainId];
	if (sourceChain === undefined) {
		return { ok: false, error: { kind: "chain_not_listed", chainId: source.chainId } };
	}
	if (destinationChain === undefined) {
		return { ok: false, error: { kind: "chain_not_listed", chainId: destination.chainId } };
	}
	return buildQuoteRequest({ ...params, sourceChain, destinationChain });
}
