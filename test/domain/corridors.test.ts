import { describe, expect, it } from "vitest";
import {
	corridorListText,
	type DefaultsListing,
	discoverCorridors,
	type ListedChain,
} from "../../src/domain/corridors";
import { defaultsListingSchema } from "../../src/gateway/schemas";
import { fixtures, testnetCorridors, testnetListing } from "../support/fixtures";

const chain = (overrides: Partial<ListedChain>): ListedChain => ({
	escrow_contract: "0xescrow",
	quote_selector: "0xselector",
	fulfillment_proxy: "0xproxy",
	fulfillment_verifier: { account: "0xverifier", endpoint: "https://verifier.example" },
	tokens: [{ address: "0xaaaa", decimals: 6, symbol: "USDC" }],
	...overrides,
});

describe("discoverCorridors", () => {
	it("finds 24 assets and every ordered pair of them on testnet", () => {
		const { assets, corridors } = discoverCorridors(testnetListing, null);
		expect(assets).toHaveLength(24);
		expect(corridors).toHaveLength(24 * 23);
		expect(corridors[0]?.id).toBe(
			"eip155:11142220/erc20:0x01c5c0122039549ad1493b8220cabedd739bc44e>eip155:11142220/erc20:0xd077a400968890eacc75cdc901f0356c943e4fdb",
		);
		const ids = corridors.map((corridor) => corridor.id);
		expect(ids).toStrictEqual([...ids].sort());
		expect(corridors.every((corridor) => corridor.source.id !== corridor.destination.id)).toBe(
			true,
		);
	});

	it("names assets by namespace standard and keeps the listing's chain id spelling", () => {
		const ids = discoverCorridors(testnetListing, null).assets.map((asset) => asset.id);
		expect(ids).toContain("tron:shasta/trc20:TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs");
		expect(ids).toContain(
			"solana:etwtrabzayq6imfeykouru166vu2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
		);
		expect(ids).toContain("eip155:84532/erc20:0x6122c5964d39416c3f34475d00ceb37f50700314");
	});

	it("keeps the mainnet decimals and symbols", () => {
		const listing = defaultsListingSchema.parse(fixtures.mainnetDefaults);
		const weth = discoverCorridors(listing, null).assets.find((asset) => asset.symbol === "WETH");
		expect(weth).toStrictEqual({
			id: "eip155:1/erc20:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
			chainId: "eip155:1",
			namespace: "eip155",
			symbol: "WETH",
			decimals: 18,
		});
	});

	it("treats EVM token addresses that differ only in case as one asset", () => {
		const listing: DefaultsListing = {
			"eip155:1": chain({
				tokens: [
					{ address: "0xAbCd", decimals: 6, symbol: "USDC" },
					{ address: "0xabcd", decimals: 6, symbol: "USDC" },
				],
			}),
			"tron:shasta": chain({
				tokens: [
					{ address: "TAbc", decimals: 6, symbol: "USDT" },
					{ address: "Tabc", decimals: 6, symbol: "USDT" },
				],
			}),
		};
		const { assets, corridors } = discoverCorridors(listing, null);
		expect(assets.map((asset) => asset.id)).toStrictEqual([
			"eip155:1/erc20:0xabcd",
			"tron:shasta/trc20:TAbc",
			"tron:shasta/trc20:Tabc",
		]);
		expect(corridors).toHaveLength(3 * 2);
		expect(corridors.every((corridor) => corridor.source.id !== corridor.destination.id)).toBe(
			true,
		);
	});

	it("skips chains it cannot probe instead of failing", () => {
		const listing: DefaultsListing = {
			"eip155:1": chain({}),
			"eip155:2": chain({ tokens: [{ address: "0xbbbb", decimals: 6, symbol: "USDT" }] }),
			"stellar:pubnet": chain({ tokens: [{ address: "GCCC", decimals: 7, symbol: "USDC" }] }),
			"eip155:3": chain({
				escrow_contract: "",
				tokens: [{ address: "0xcc", decimals: 6, symbol: "X" }],
			}),
			"eip155:4": chain({ tokens: [] }),
		};
		const { assets, corridors } = discoverCorridors(listing, null);
		expect(assets.map((asset) => asset.id)).toStrictEqual([
			"eip155:1/erc20:0xaaaa",
			"eip155:2/erc20:0xbbbb",
		]);
		expect(corridors.map((corridor) => corridor.id)).toStrictEqual([
			"eip155:1/erc20:0xaaaa>eip155:2/erc20:0xbbbb",
			"eip155:2/erc20:0xbbbb>eip155:1/erc20:0xaaaa",
		]);
	});

	it("keeps only corridors whose chain and symbol label matches the filter", () => {
		const { corridors } = discoverCorridors(
			testnetListing,
			/^eip155:421614\/USDC>eip155:84532\/USDC$/,
		);
		expect(corridors.map((corridor) => corridor.id)).toStrictEqual([
			"eip155:421614/erc20:0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d>eip155:84532/erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e",
		]);
		expect(discoverCorridors(testnetListing, /^tron:shasta\//).corridors).toHaveLength(2 * 23);
	});
});

describe("corridorListText", () => {
	const [first, second, ...rest] = testnetCorridors;
	if (first === undefined || second === undefined) throw new Error("fixture has no corridors");

	it("does not depend on the order of the list", () => {
		expect(corridorListText([second, first, ...rest])).toBe(corridorListText(testnetCorridors));
	});

	it("changes with a corridor, a symbol or a decimals value", () => {
		const base = corridorListText(testnetCorridors);
		expect(corridorListText([second, ...rest])).not.toBe(base);
		const renamed = { ...first, source: { ...first.source, symbol: "USDC.e" } };
		expect(corridorListText([renamed, second, ...rest])).not.toBe(base);
		const redecimaled = { ...first, destination: { ...first.destination, decimals: 18 } };
		expect(corridorListText([redecimaled, second, ...rest])).not.toBe(base);
	});
});
