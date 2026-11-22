import {
	type ApiRequestOptions,
	CancelablePromise,
	type OpenAPIConfig,
	PAYMENT_REQUEST_VERSION,
	PaymentGatewayClient,
} from "@atumlabs/payment-gateway-client";
import sdkPackage from "@atumlabs/payment-gateway-client/package.json";
import { describe, expect, it } from "vitest";
import { discoverCorridors } from "../../src/domain/corridors";
import { PROBE_IDENTITY } from "../../src/domain/identity";
import { probeTargets } from "../../src/domain/schedule";
import type { ChainNamespace, ProbeTarget } from "../../src/domain/types";
import {
	buildQuoteRequestFromListing,
	QUOTE_REQUEST_VERSION,
} from "../../src/gateway/quote-request";
import { defaultsListingSchema } from "../../src/gateway/schemas";
import mainnetDefaults from "../fixtures/gateway/defaults.mainnet.json";
import testnetDefaults from "../fixtures/gateway/defaults.testnet.json";
import { probeIdOf } from "../support/ids";

type Transport = ConstructorParameters<typeof PaymentGatewayClient>[1];

/** Answers `GET /v1/defaults?chain_id=` from a listing and refuses everything else. */
function offlineTransport(listing: Readonly<Record<string, unknown>>): Transport {
	return class {
		constructor(readonly config: OpenAPIConfig) {}
		/** The SDK picks `T` per call and validates the defaults it receives. */
		request<T>(options: ApiRequestOptions): CancelablePromise<T>;
		request(options: ApiRequestOptions): CancelablePromise<unknown> {
			return new CancelablePromise((resolve, reject) => {
				const hit = listing[String(options.query?.chain_id ?? "")];
				if (options.method === "GET" && options.url === "/v1/defaults" && hit !== undefined) {
					resolve(hit);
				} else {
					reject(new Error(`offline transport: ${options.method} ${options.url}`));
				}
			});
		}
	};
}

const BODY_KEYS = [
	"version",
	"request_id",
	"source",
	"destination",
	"fulfillment_amount",
	"quote_deadline",
	"fulfillment_deadline",
	"escrow_contract_address",
	"quote_selector",
	"fulfillment_verifier",
	"fulfillment_proxy",
];

function withoutDeadlines(body: object): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(body).filter(
			([key]) => key !== "quote_deadline" && key !== "fulfillment_deadline",
		),
	);
}

async function compareWithSdk(raw: Readonly<Record<string, unknown>>, target: ProbeTarget) {
	const listing = defaultsListingSchema.parse(raw);
	const requestId = probeIdOf("cw1.testnet.20261122T1035Z.0123456789ab.small");
	const nowMs = Date.parse("2026-11-22T10:35:00.000Z");
	const ours = buildQuoteRequestFromListing({
		target,
		listing,
		identity: PROBE_IDENTITY,
		requestId,
		nowMs,
		quoteWindowSeconds: 3,
	});
	if (!ours.ok) throw new Error(`builder refused: ${JSON.stringify(ours.error)}`);
	const client = new PaymentGatewayClient(
		{ BASE: "https://offline.invalid" },
		offlineTransport(raw),
	);
	const { source, destination } = target.corridor;
	const sdk = await client.prepareQuoteRequest({
		depositor: PROBE_IDENTITY[source.namespace],
		sourceAsset: source.id,
		destinationAccount: PROBE_IDENTITY[destination.namespace],
		destinationAsset: destination.id,
		fulfillmentAmount: target.fulfillmentAmount,
		requestId,
		quoteDeadlineSeconds: 3,
	});
	expect(withoutDeadlines(ours.body)).toStrictEqual(withoutDeadlines(sdk));
	return ours.body;
}

const testnet = discoverCorridors(defaultsListingSchema.parse(testnetDefaults), null);
const targets = probeTargets(testnet.corridors, { small: "1" });

function firstTarget(
	from: ChainNamespace,
	to: ChainNamespace,
	sameChain: boolean | null = null,
): ProbeTarget {
	const found = targets.find(
		({ corridor: { source, destination } }) =>
			source.namespace === from &&
			destination.namespace === to &&
			(sameChain === null || (source.chainId === destination.chainId) === sameChain),
	);
	if (found === undefined) throw new Error(`no ${from} to ${to} corridor in the fixture`);
	return found;
}

describe("quote request builder against SDK 6", () => {
	it("is checked against SDK 6.0.0 or later", () => {
		const [major = 0] = sdkPackage.version.split(".").map(Number);
		expect(major).toBeGreaterThanOrEqual(6);
		expect(QUOTE_REQUEST_VERSION).toBe(PAYMENT_REQUEST_VERSION);
	});

	it.each([
		["eip155", "eip155", false],
		["eip155", "solana", null],
		["eip155", "tron", null],
		["solana", "eip155", null],
		["solana", "tron", null],
		["tron", "eip155", null],
		["tron", "solana", null],
		["tron", "tron", true],
	] as const)("builds the SDK's body from %s to %s", async (from, to, sameChain) => {
		const body = await compareWithSdk(testnetDefaults, firstTarget(from, to, sameChain));
		expect(Object.keys(body)).toStrictEqual(BODY_KEYS);
		expect(body).not.toHaveProperty("sender_auth");
		expect(body).not.toHaveProperty("max_source_amount");
	});

	it("names the depositor as quote selector, in hex for Tron", async () => {
		const evm = await compareWithSdk(testnetDefaults, firstTarget("eip155", "solana"));
		expect(evm.quote_selector).toBe(PROBE_IDENTITY.eip155);
		expect(evm.quote_selector).not.toBe(testnetDefaults["eip155:11142220"].quote_selector);

		const tron = await compareWithSdk(testnetDefaults, firstTarget("tron", "eip155"));
		expect(tron.source.account).toBe("TVTWhtawdkwzezxjU4qi7k4FDqFtn7X5N1");
		expect(tron.quote_selector).toBe("0xd5c4d0bbcc3f01886cb1e8e29bb348776892270f");
		expect(tron.fulfillment_verifier.account).toBe("0xd0f080e23f95571d26eeb1fad24a5f3d66835195");
	});

	it("matches the SDK on every testnet and mainnet corridor", async () => {
		const mainnet = discoverCorridors(defaultsListingSchema.parse(mainnetDefaults), null);
		for (const target of probeTargets(testnet.corridors, { small: "1" })) {
			await compareWithSdk(testnetDefaults, target);
		}
		for (const target of probeTargets(mainnet.corridors, { small: "1" })) {
			await compareWithSdk(mainnetDefaults, target);
		}
	});
});
