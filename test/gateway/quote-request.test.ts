import { describe, expect, it } from "vitest";
import type { ListedChain } from "../../src/domain/corridors";
import { PROBE_IDENTITY } from "../../src/domain/identity";
import { probeTargets } from "../../src/domain/schedule";
import type { ChainNamespace, ProbeIdentity, ProbeTarget } from "../../src/domain/types";
import {
	buildQuoteRequest,
	buildQuoteRequestFromListing,
	type QuoteRequestBuild,
} from "../../src/gateway/quote-request";
import { testnetCorridors, testnetListing } from "../support/fixtures";
import { probeIdOf } from "../support/ids";

const NOW = Date.parse("2026-11-22T10:35:00.000Z");
const requestId = probeIdOf("cw1.testnet.20261122T1035Z.7ae33acb9dd6.small");
const targets = probeTargets(testnetCorridors, { small: "1" });

function from(namespace: ChainNamespace): ProbeTarget {
	const target = targets.find((candidate) => candidate.corridor.source.namespace === namespace);
	if (target === undefined) throw new Error(`no ${namespace} corridor`);
	return target;
}

function chainOf(chainId: string): ListedChain {
	const chain = testnetListing[chainId];
	if (chain === undefined) throw new Error(`no chain ${chainId}`);
	return chain;
}

function build(target: ProbeTarget, identity: ProbeIdentity = PROBE_IDENTITY): QuoteRequestBuild {
	return buildQuoteRequestFromListing({
		target,
		listing: testnetListing,
		identity,
		requestId,
		nowMs: NOW,
		quoteWindowSeconds: 3,
	});
}

function body(target: ProbeTarget) {
	const result = build(target);
	if (!result.ok) throw new Error(JSON.stringify(result.error));
	return result.body;
}

describe("buildQuoteRequest", () => {
	it.each(["eip155", "solana"] as const)(
		"names the %s depositor as quote selector, never the gateway's selector",
		(namespace) => {
			const target = from(namespace);
			const built = body(target);
			const gatewaySelector = chainOf(target.corridor.source.chainId).quote_selector;
			expect(built.quote_selector).toBe(PROBE_IDENTITY[namespace]);
			expect(built.quote_selector.toLowerCase()).not.toBe(gatewaySelector.toLowerCase());
			expect(built.source.account).toBe(PROBE_IDENTITY[namespace]);
			expect(built).not.toHaveProperty("sender_auth");
		},
	);

	it("writes a Tron depositor and verifier as 0x hex and keeps the T-address as account", () => {
		const built = body(from("tron"));
		expect(built.source.account).toBe("TVTWhtawdkwzezxjU4qi7k4FDqFtn7X5N1");
		expect(built.quote_selector).toBe("0xd5c4d0bbcc3f01886cb1e8e29bb348776892270f");
		expect(built.fulfillment_verifier).toStrictEqual({
			account: "0xd0f080e23f95571d26eeb1fad24a5f3d66835195",
			endpoint: "https://veri-fill-382477456811.us-central1.run.app",
		});
		expect(built).not.toHaveProperty("sender_auth");
	});

	it("takes escrow and verifier from the source chain and the proxy from the destination", () => {
		const target = targets.find(
			({ corridor }) =>
				corridor.source.chainId === "eip155:421614" &&
				corridor.destination.chainId === "solana:etwtrabzayq6imfeykouru166vu2xqa1",
		);
		if (target === undefined) throw new Error("no corridor");
		expect(body(target)).toMatchObject({
			version: "1.3",
			request_id: requestId,
			destination: [
				{
					asset_identifier:
						"solana:etwtrabzayq6imfeykouru166vu2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
					account: "5YdDoh63Jeu5WMMwxfwYS5uHE5Sru6M8BcUech2G671N",
				},
			],
			fulfillment_amount: "1000000",
			escrow_contract_address: "0x0F875601504C9179562506AFa34b2D084268869b",
			fulfillment_verifier: { account: "0x27050EE47befC43F4dF7807a7AA8073039e5fa89" },
			fulfillment_proxy: "FGMSseEvfdXHWnYwDcSyCorqJr3pT83zuasdy8ve8KmS",
		});
	});

	it("stamps the quote and fulfillment deadlines from the given time", () => {
		expect(body(from("eip155"))).toMatchObject({
			quote_deadline: "2026-11-22T10:35:03.000Z",
			fulfillment_deadline: "2026-11-22T10:40:00.000Z",
		});
	});

	it("refuses a depositor that is the gateway's own selector", () => {
		const evm = from("eip155");
		const gatewaySelector = chainOf(evm.corridor.source.chainId).quote_selector;
		expect(build(evm, { ...PROBE_IDENTITY, eip155: gatewaySelector.toLowerCase() })).toStrictEqual({
			ok: false,
			error: { kind: "selector_is_gateway_selector", selector: gatewaySelector.toLowerCase() },
		});
		expect(
			build(from("tron"), { ...PROBE_IDENTITY, tron: "TV1yfS3LQAPpNqSr1cL3C4L4551atNyuih" }),
		).toStrictEqual({
			ok: false,
			error: {
				kind: "selector_is_gateway_selector",
				selector: "0xd0f080e23f95571d26eeb1fad24a5f3d66835195",
			},
		});
	});

	it("refuses a Tron address it cannot decode", () => {
		expect(build(from("tron"), { ...PROBE_IDENTITY, tron: "T0OIl" })).toStrictEqual({
			ok: false,
			error: { kind: "invalid_tron_address", address: "T0OIl" },
		});
		const tron = from("tron");
		const result = buildQuoteRequest({
			target: tron,
			sourceChain: { ...chainOf("tron:shasta"), quote_selector: "0x1234" },
			destinationChain: chainOf(tron.corridor.destination.chainId),
			identity: PROBE_IDENTITY,
			requestId,
			nowMs: NOW,
			quoteWindowSeconds: 3,
		});
		expect(result).toStrictEqual({
			ok: false,
			error: { kind: "invalid_tron_address", address: "0x1234" },
		});
	});

	it("reports a chain missing from the listing", () => {
		const target = from("eip155");
		const result = buildQuoteRequestFromListing({
			target,
			listing: {},
			identity: PROBE_IDENTITY,
			requestId,
			nowMs: NOW,
			quoteWindowSeconds: 3,
		});
		expect(result).toStrictEqual({
			ok: false,
			error: { kind: "chain_not_listed", chainId: target.corridor.source.chainId },
		});
	});
});
