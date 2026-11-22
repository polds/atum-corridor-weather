import { discoverCorridors } from "../../src/domain/corridors";
import type { Corridor } from "../../src/domain/types";
import { defaultsListingSchema } from "../../src/gateway/schemas";
import mainnetDefaults from "../fixtures/gateway/defaults.mainnet.json";
import testnetDefaults from "../fixtures/gateway/defaults.testnet.json";
import declinedLiquidity from "../fixtures/gateway/probe.declined-insufficient-liquidity.json";
import declinedInternal from "../fixtures/gateway/probe.declined-internal.json";
import quoted from "../fixtures/gateway/probe.quoted.json";

/** One recorded testnet exchange: `t` is ms after the create call was sent. */
export interface FixtureEvent {
	readonly t: number;
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly json: unknown;
}

/** `events[0]` answers the create call, the rest answer successive polls. */
export interface ProbeFixture {
	readonly body: unknown;
	readonly events: readonly FixtureEvent[];
}

export const fixtures = {
	testnetDefaults,
	mainnetDefaults,
	quoted: quoted satisfies ProbeFixture,
	declinedLiquidity: declinedLiquidity satisfies ProbeFixture,
	declinedInternal: declinedInternal satisfies ProbeFixture,
};

export const testnetListing = defaultsListingSchema.parse(testnetDefaults);
export const testnetCorridors = discoverCorridors(testnetListing, null).corridors;

/** The corridor of `probe.quoted.json`: Arbitrum Sepolia USDC to Base Sepolia USDC. */
export const ARB_TO_BASE_USDC =
	"eip155:421614/erc20:0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d>eip155:84532/erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e";

/** The settler that signed the quote in `probe.quoted.json`. */
export const QUOTED_SETTLER = "0x0eee42ec90eb7d1e53504fb508790e410a286a11";

export function corridorById(id: string): Corridor {
	const corridor = testnetCorridors.find((candidate) => candidate.id === id);
	if (corridor === undefined) throw new Error(`no corridor ${id} in the testnet fixture`);
	return corridor;
}

/** `probe.declined-insufficient-liquidity.json` with `declines` as the decline summary of every poll. */
export function declinedWith(declines: readonly unknown[]): ProbeFixture {
	const [created, ...polls] = declinedLiquidity.events;
	if (created === undefined) throw new Error("fixture has no events");
	return {
		body: declinedLiquidity.body,
		events: [
			created,
			...polls.map((event) => ({ ...event, json: { ...event.json, decline_summary: declines } })),
		],
	};
}
