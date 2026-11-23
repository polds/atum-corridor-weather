/**
 * Deterministic fixture documents for previewing the dashboard with
 * `pnpm run build:dashboard --serve`. Dev tool only: the production bundle
 * never imports this file.
 *
 * The assets are the testnet assets in test/fixtures/gateway/defaults.testnet.json.
 * Every reading is made up. Spreads, operator counts and declines are random
 * but seeded, so the same `now` always gives the same documents.
 */
import type {
	Alert,
	Condition,
	CorridorConditions,
	CorridorHistory,
	HistoryPoint,
	Snapshot,
	SnapshotAsset,
	SnapshotDecline,
	TierReading,
} from "../../src/domain/snapshot";
import type {
	AmountTier,
	AssetId,
	AtomicAmount,
	ChainId,
	CorridorId,
	IsoTimestamp,
	ProbeOutcomeKind,
} from "../../src/domain/types";

export type FixtureMode = "normal" | "stale";

// ---------------------------------------------------------------------------
// Brands, checked rather than cast

function isChainId(v: string): v is ChainId {
	return /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/.test(v);
}
function isAssetId(v: string): v is AssetId {
	return /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}\/[a-z0-9]+:[a-zA-Z0-9]+$/.test(v);
}
function isCorridorId(v: string): v is CorridorId {
	const [source, destination, ...rest] = v.split(">");
	return (
		rest.length === 0 &&
		source !== undefined &&
		destination !== undefined &&
		isAssetId(source) &&
		isAssetId(destination)
	);
}
function isAtomic(v: string): v is AtomicAmount {
	return /^\d+$/.test(v);
}
function isIso(v: string): v is IsoTimestamp {
	return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v);
}

function brand<T extends string>(guard: (v: string) => v is T, v: string): T {
	if (!guard(v)) throw new Error(`fixture value has the wrong shape: ${v}`);
	return v;
}

const iso = (ms: number): IsoTimestamp => brand(isIso, new Date(ms).toISOString());
const atomic = (v: bigint): AtomicAmount => brand(isAtomic, v.toString());

// ---------------------------------------------------------------------------
// Seeded randomness

function hash(text: string): number {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** mulberry32 */
function rng(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ---------------------------------------------------------------------------
// Assets: 24 on 10 chains, as on testnet

const CHAINS: readonly {
	id: string;
	label: string;
	standard: string;
	tokens: readonly [string, string][];
}[] = [
	{
		id: "eip155:11155111",
		label: "Ethereum Sepolia",
		standard: "erc20",
		tokens: [
			["USDC", "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238"],
			["USDT", "0xaa8e23fb1079ea71e0a56f48a2aa51851d8433d0"],
			["PYUSD", "0xcac524bca292aaade2df8a05cc58f0a65b1b3bb9"],
		],
	},
	{
		id: "eip155:421614",
		label: "Arbitrum Sepolia",
		standard: "erc20",
		tokens: [
			["USDC", "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d"],
			["USDT", "0x93d67359a0f6f117150a70fdde6bb96782497248"],
			["PYUSD", "0x637a1259c6afd7e3adf63993ca7e58bb438ab1b1"],
		],
	},
	{
		id: "eip155:84532",
		label: "Base Sepolia",
		standard: "erc20",
		tokens: [
			["USDC", "0x036cbd53842c5426634e7929541ec2318f3dcf7e"],
			["rUSD", "0x6122c5964d39416c3f34475d00ceb37f50700314"],
		],
	},
	{
		id: "eip155:11155420",
		label: "OP Sepolia",
		standard: "erc20",
		tokens: [
			["USDC", "0x5fd84259d66cd46123540766be93dfe6d43130d7"],
			["USDT", "0x7e09dd0b7c434f9f8f7cd98b8db3d6a25d89c8a2"],
		],
	},
	{
		id: "eip155:43113",
		label: "Avalanche Fuji",
		standard: "erc20",
		tokens: [
			["USDC", "0x5425890298aed601595a70ab815c96711a31bc65"],
			["USDT", "0x134dc38ae8c853d1aa2103d5047591acdaa16682"],
		],
	},
	{
		id: "eip155:80002",
		label: "Polygon Amoy",
		standard: "erc20",
		tokens: [["USDC", "0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582"]],
	},
	{
		id: "eip155:11142220",
		label: "Celo Sepolia",
		standard: "erc20",
		tokens: [
			["USDC", "0x01c5c0122039549ad1493b8220cabedd739bc44e"],
			["USDT", "0xd077a400968890eacc75cdc901f0356c943e4fdb"],
		],
	},
	{
		id: "eip155:42431",
		label: "Tempo Testnet",
		standard: "erc20",
		tokens: [
			["OUSD", "0x20c0000000000000000000006a37da5c996874be"],
			["pathUSD", "0x20c0000000000000000000000000000000000000"],
			["alphaUSD", "0x20c0000000000000000000000000000000000001"],
			["betaUSD", "0x20c0000000000000000000000000000000000002"],
			["thetaUSD", "0x20c0000000000000000000000000000000000003"],
			["USDC.e", "0x20c0000000000000000000009e8d7eb59b783726"],
		],
	},
	{
		id: "solana:etwtrabzayq6imfeykouru166vu2xqa1",
		label: "Solana Devnet",
		standard: "token",
		tokens: [["USDC", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"]],
	},
	{
		id: "tron:shasta",
		label: "Tron Shasta",
		standard: "trc20",
		tokens: [
			["USDT", "TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs"],
			["USDC", "TSdZwNqpHofzP6BsBKGQUWdBeJphLmF6id"],
		],
	},
];

const ASSETS: readonly SnapshotAsset[] = CHAINS.flatMap((chain) =>
	chain.tokens.map(([symbol, address]) => ({
		id: brand(isAssetId, `${chain.id}/${chain.standard}:${address}`),
		chainId: brand(isChainId, chain.id),
		chainLabel: chain.label,
		symbol,
		decimals: 6,
	})),
);

/** Tokens whose peg the fixture treats as unknown, so their spreads are null. */
const OTHER_PEG = new Set(["rUSD", "thetaUSD"]);
/** Tokens added "recently": most of their corridors have not been probed yet. */
const NEW_TOKENS = new Set(["alphaUSD", "betaUSD", "thetaUSD", "pathUSD"]);
const MAJOR_CHAINS = new Set([
	"eip155:11155111",
	"eip155:421614",
	"eip155:84532",
	"eip155:11155420",
]);

const TIERS: readonly { tier: AmountTier; whole: bigint }[] = [
	{ tier: "small", whole: 1n },
	{ tier: "typical", whole: 25n },
	{ tier: "large", whole: 250n },
];

const TICK_MINUTES = 5;
const PROBES_PER_TICK = 30;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Pair {
	readonly index: number;
	readonly id: CorridorId;
	readonly source: SnapshotAsset;
	readonly destination: SnapshotAsset;
}

const PAIRS: readonly Pair[] = ASSETS.flatMap((source) =>
	ASSETS.filter((d) => d.id !== source.id).map((destination) => ({ source, destination })),
)
	.map((p) => ({ ...p, id: brand(isCorridorId, `${p.source.id}>${p.destination.id}`) }))
	.sort((a, b) => (a.id < b.id ? -1 : 1))
	.map((p, index) => ({ ...p, index }));

const SWEEP_MS = Math.ceil((PAIRS.length * TIERS.length) / PROBES_PER_TICK) * TICK_MINUTES * 60_000;

/** The corridor that lost its quotes at every tier in the last half day: `quotes_lost`. */
export const QUOTES_LOST_CORRIDOR = pairId("Arbitrum Sepolia", "USDC", "Base Sepolia", "USDC");
const SLOW_CORRIDOR = pairId("Ethereum Sepolia", "PYUSD", "OP Sepolia", "USDT");
/** Lost only its large tier: cloudy, and no alert, because the other tiers still quote. */
const LOST_LARGE_CORRIDOR = pairId("OP Sepolia", "USDT", "Avalanche Fuji", "USDC");

function pairId(
	srcChain: string,
	srcSymbol: string,
	dstChain: string,
	dstSymbol: string,
): CorridorId {
	const p = PAIRS.find(
		(x) =>
			x.source.chainLabel === srcChain &&
			x.source.symbol === srcSymbol &&
			x.destination.chainLabel === dstChain &&
			x.destination.symbol === dstSymbol,
	);
	if (p === undefined)
		throw new Error(`no fixture corridor ${srcSymbol}@${srcChain} > ${dstSymbol}@${dstChain}`);
	return p.id;
}

type Profile = "healthy" | "shallow" | "flaky" | "dead";

function profileOf(p: Pair): Profile {
	if (p.id === QUOTES_LOST_CORRIDOR || p.id === SLOW_CORRIDOR || p.id === LOST_LARGE_CORRIDOR)
		return "healthy";
	const roll = rng(hash(`profile:${p.id}`))();
	const evm = (a: SnapshotAsset): boolean => a.chainId.startsWith("eip155:");
	const major = MAJOR_CHAINS.has(p.source.chainId) && MAJOR_CHAINS.has(p.destination.chainId);
	if (!evm(p.source) || !evm(p.destination)) return roll < 0.15 ? "flaky" : "dead";
	if (p.source.chainId === "eip155:42431" || p.destination.chainId === "eip155:42431")
		return roll < 0.12 ? "shallow" : "dead";
	if (major) return roll < 0.55 ? "healthy" : roll < 0.85 ? "shallow" : "flaky";
	return roll < 0.22 ? "healthy" : roll < 0.45 ? "shallow" : roll < 0.6 ? "flaky" : "dead";
}

/** When this corridor's probes began. New-token corridors began a few hours ago, or not yet. */
function firstProbeAt(p: Pair, now: number): number | null {
	if (!NEW_TOKENS.has(p.source.symbol) && !NEW_TOKENS.has(p.destination.symbol))
		return now - 30 * DAY;
	const r = rng(hash(`new:${p.id}`))();
	return r < 0.25 ? now - r * 4 * SWEEP_MS : null;
}

// ---------------------------------------------------------------------------
// One probe

interface Probe {
	readonly probedAt: number;
	readonly tier: AmountTier;
	readonly fulfillmentAmount: AtomicAmount;
	readonly outcome: ProbeOutcomeKind;
	readonly quoteCount: number;
	readonly operatorCount: number;
	readonly bestSourceAmount: AtomicAmount | null;
	readonly bestSpreadBps: number | null;
	readonly worstSpreadBps: number | null;
	readonly firstQuoteMs: number | null;
	readonly readyMs: number | null;
	readonly minPriceHoldMs: number | null;
	readonly declines: readonly SnapshotDecline[];
}

const decline = (
	reason: string,
	retryClassification: string | null,
	count = 1,
): SnapshotDecline => ({ reason, retryClassification, count });

function probe(p: Pair, tierIndex: number, at: number, now: number): Probe {
	const r = rng(hash(`${p.id}|${tierIndex}|${at}`));
	const tierDef = TIERS[tierIndex] ?? { tier: "typical", whole: 25n };
	const tier = tierDef.tier;
	const amount = tierDef.whole * 1_000_000n;
	const base = {
		probedAt: at,
		tier,
		fulfillmentAmount: atomic(amount),
		quoteCount: 0,
		operatorCount: 0,
		bestSourceAmount: null,
		bestSpreadBps: null,
		worstSpreadBps: null,
		firstQuoteMs: null,
		readyMs: null,
		minPriceHoldMs: null,
		declines: [],
	} satisfies Omit<Probe, "outcome">;

	// Occasional failures anywhere.
	// The alert demos stay clean so their story reads; every other corridor sees noise.
	const demo =
		p.id === QUOTES_LOST_CORRIDOR || p.id === SLOW_CORRIDOR || p.id === LOST_LARGE_CORRIDOR;
	const noise = demo ? 1 : r();
	if (noise < 0.015) return { ...base, outcome: "gateway_error" };
	if (noise < 0.03) return { ...base, outcome: "incomplete" };

	const profile = profileOf(p);
	const lostRecently =
		(p.id === QUOTES_LOST_CORRIDOR && at > now - 11 * HOUR) ||
		(p.id === LOST_LARGE_CORRIDOR && tier === "large" && at > now - 6 * HOUR);
	let quoted: boolean;
	switch (profile) {
		case "healthy":
			quoted = r() < 0.96;
			break;
		case "shallow":
			quoted = tier === "large" ? r() < 0.08 : r() < 0.9;
			break;
		case "flaky":
			quoted = r() < 0.45;
			break;
		case "dead":
			quoted = false;
			break;
		default: {
			const _exhaustive: never = profile;
			quoted = _exhaustive;
		}
	}
	if (lostRecently) quoted = false;

	if (!quoted) {
		const kind = r();
		if (lostRecently) {
			return tier === "large" || kind < 0.6
				? {
						...base,
						outcome: "declined",
						declines: [
							decline("INSUFFICIENT_LIQUIDITY", "RETRY_AFTER_DELAY", 1 + Math.floor(r() * 2)),
						],
					}
				: { ...base, outcome: "silent" };
		}
		if (profile === "shallow" && tier === "large") {
			return {
				...base,
				outcome: "declined",
				declines: [decline("INSUFFICIENT_LIQUIDITY", "RETRY_AFTER_DELAY", 1 + Math.floor(r() * 3))],
			};
		}
		if (profile === "dead") {
			if (p.source.chainId.startsWith("tron:") || p.destination.chainId.startsWith("tron:")) {
				return kind < 0.6
					? { ...base, outcome: "declined", declines: [decline("INTERNAL", "RETRY_AFTER_DELAY")] }
					: { ...base, outcome: "silent" };
			}
			if (kind < 0.45)
				return {
					...base,
					outcome: "declined",
					declines: [
						decline(
							"UNSUPPORTED_DESTINATION_ASSET",
							"NOT_RETRYABLE_FIX_REQUEST",
							1 + Math.floor(r() * 2),
						),
					],
				};
			if (kind < 0.52)
				return {
					...base,
					outcome: "declined",
					declines: [decline("COMPLIANCE_REVIEW_REQUIRED", "CONTACT_SUPPORT")],
				};
			return { ...base, outcome: "silent" };
		}
		if (kind < 0.5) return { ...base, outcome: "silent" };
		if (kind < 0.8)
			return {
				...base,
				outcome: "declined",
				declines: [decline("QUOTE_EXPIRED_BEFORE_WINDOW", null)],
			};
		return {
			...base,
			outcome: "declined",
			declines: [decline("INSUFFICIENT_LIQUIDITY", "RETRY_AFTER_DELAY")],
		};
	}

	const pairBase = 1 + (hash(`spread:${p.id}`) % 180) / 10;
	const tierFactor = tier === "small" ? 2.6 : tier === "typical" ? 1 : 0.85;
	const drift = 1 + 0.25 * Math.sin(at / (17 * HOUR) + (hash(p.id) % 7));
	const tenths = Math.max(1, Math.round(pairBase * tierFactor * drift * (0.9 + r() * 0.2) * 10));
	const crossPeg = OTHER_PEG.has(p.source.symbol) || OTHER_PEG.has(p.destination.symbol);
	const operators = profile === "healthy" ? 2 + Math.floor(r() * 3) : 1 + Math.floor(r() * 2);
	const quotes = operators + (r() < 0.2 ? 1 : 0);
	const worstTenths = tenths + (operators > 1 ? Math.round(r() * 40) : 0);
	const slow = p.id === SLOW_CORRIDOR && at > now - 8 * HOUR;
	const firstQuoteMs = slow ? 2600 + Math.round(r() * 300) : 280 + Math.round(r() * 1500);
	const partialDeclines =
		operators > 1 && r() < 0.2 ? [decline("INSUFFICIENT_LIQUIDITY", "RETRY_AFTER_DELAY")] : [];
	return {
		...base,
		outcome: "quoted",
		quoteCount: quotes,
		operatorCount: operators,
		bestSourceAmount: atomic(amount + (amount * BigInt(tenths)) / 100_000n),
		bestSpreadBps: crossPeg ? null : tenths / 10,
		worstSpreadBps: crossPeg ? null : worstTenths / 10,
		firstQuoteMs,
		readyMs: 3000 + Math.round(r() * 120),
		minPriceHoldMs: 20_000 + Math.round(r() * 40_000),
		declines: partialDeclines,
	};
}

/** Probe times for one corridor tier: one per sweep, at its fixed offset in the sweep. */
function probeTimes(p: Pair, tierIndex: number, from: number, now: number): readonly number[] {
	const first = firstProbeAt(p, now);
	if (first === null) return [];
	const slotMs = TICK_MINUTES * 60_000;
	const position = p.index * TIERS.length + tierIndex;
	const offset =
		Math.floor(position / PROBES_PER_TICK) * slotMs + (position % PROBES_PER_TICK) * 3500;
	const times: number[] = [];
	const start = Math.max(from, first);
	let t = Math.floor((start - offset) / SWEEP_MS) * SWEEP_MS + offset;
	if (t < start) t += SWEEP_MS;
	for (; t <= now; t += SWEEP_MS) times.push(t);
	return times;
}

// ---------------------------------------------------------------------------
// Documents

export function buildSnapshot(nowMs: number, mode: FixtureMode = "normal"): Snapshot {
	// A stale snapshot was generated 47 minutes ago and nothing has run since.
	const generatedAt = mode === "stale" ? nowMs - 47 * 60_000 : nowMs - 70_000;
	const now = generatedAt - 20_000;
	const corridors: CorridorConditions[] = PAIRS.map((p) => {
		const tiers: TierReading[] = [];
		TIERS.forEach((_, ti) => {
			const last = probeTimes(p, ti, now - 2 * SWEEP_MS, now).at(-1);
			if (last !== undefined) {
				const { probedAt, ...rest } = probe(p, ti, last, now);
				tiers.push({ ...rest, probedAt: iso(probedAt) });
			}
		});
		const quoted = tiers.filter((t) => t.outcome === "quoted").length;
		const condition: Condition =
			tiers.length === 0
				? "unknown"
				: quoted === tiers.length
					? "fair"
					: quoted > 0
						? "cloudy"
						: "stormy";
		const lastProbedAt =
			tiers
				.map((t) => t.probedAt)
				.sort()
				.at(-1) ?? null;
		return {
			id: p.id,
			source: p.source.id,
			destination: p.destination.id,
			condition,
			lastProbedAt,
			tiers,
		};
	});

	// quotes_lost as the Worker computes it: the last quote at any tier, and the first probe after it.
	const lostPair = PAIRS.find((x) => x.id === QUOTES_LOST_CORRIDOR);
	const lostProbes = TIERS.flatMap((_, ti) =>
		lostPair === undefined
			? []
			: probeTimes(lostPair, ti, now - 7 * DAY, now).map((t) => ({
					at: t,
					quoted: probe(lostPair, ti, t, now).outcome === "quoted",
				})),
	).sort((a, b) => a.at - b.at);
	const lastQuoteAt = lostProbes.filter((x) => x.quoted).at(-1)?.at ?? now - 7 * DAY;
	const lostSince = lostProbes.find((x) => x.at > lastQuoteAt)?.at ?? lastQuoteAt;
	const alerts: Alert[] = [
		{
			kind: "quotes_lost",
			severity: "critical",
			corridorId: QUOTES_LOST_CORRIDOR,
			message: `No tier is quoted now. The last quote was at ${iso(lastQuoteAt)}.`,
			since: iso(lostSince),
		},
		{
			kind: "slow_quotes",
			severity: "warning",
			corridorId: SLOW_CORRIDOR,
			message: "Time to first quote was 2.7 s, above the 2.5 s threshold.",
			since: iso(now - 7 * HOUR),
		},
	];
	if (mode === "stale") {
		alerts.unshift({
			kind: "prober_stale",
			severity: "critical",
			corridorId: null,
			message: "No tick has finished in the last three publish intervals.",
			since: iso(generatedAt),
		});
	}

	const slotStart = Math.floor(now / (TICK_MINUTES * 60_000)) * TICK_MINUTES * 60_000;
	return {
		schemaVersion: 1,
		network: "testnet",
		generatedAt: iso(generatedAt),
		tickIntervalMinutes: TICK_MINUTES,
		publishIntervalMinutes: TICK_MINUTES,
		cadence: {
			probesPerTick: PROBES_PER_TICK,
			sweepHours:
				Math.round(((PAIRS.length * TIERS.length) / PROBES_PER_TICK) * TICK_MINUTES * (10 / 60)) /
				10,
		},
		tiers: TIERS.map(({ tier }) => tier),
		lastTick: {
			slotStart: iso(slotStart),
			finishedAt: iso(slotStart + 104_000),
			planned: PROBES_PER_TICK,
			completed: PROBES_PER_TICK,
			gatewayErrors: 1,
			aborted: null,
		},
		assets: ASSETS,
		corridors,
		alerts,
	};
}

/** Null when the corridor id is not one of the fixture's corridors. */
export function buildHistory(
	corridorId: string,
	nowMs: number,
	days: number,
	mode: FixtureMode = "normal",
): CorridorHistory | null {
	const p = PAIRS.find((x) => x.id === corridorId);
	if (p === undefined) return null;
	const generatedAt = mode === "stale" ? nowMs - 47 * 60_000 : nowMs - 70_000;
	const now = generatedAt - 20_000;
	const from = now - days * DAY;
	const points: HistoryPoint[] = TIERS.flatMap((_, ti) =>
		probeTimes(p, ti, from, now).map((t) => {
			const {
				probedAt,
				quoteCount,
				operatorCount,
				bestSpreadBps,
				firstQuoteMs,
				declines,
				tier,
				fulfillmentAmount,
				outcome,
			} = probe(p, ti, t, now);
			return {
				probedAt: iso(probedAt),
				tier,
				fulfillmentAmount,
				outcome,
				quoteCount,
				operatorCount,
				bestSpreadBps,
				firstQuoteMs,
				declines,
			};
		}),
	).sort((a, b) => (a.probedAt < b.probedAt ? -1 : 1));
	return {
		schemaVersion: 1,
		network: "testnet",
		corridorId: p.id,
		generatedAt: iso(generatedAt),
		days,
		points,
		// The dashboard does not show daily figures yet.
		daily: [],
	};
}
