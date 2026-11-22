import type { AtomicAmount } from "./types";

const PEG_BY_SYMBOL: ReadonlyMap<string, string> = new Map([
	...[
		"USDC",
		"USDT",
		"PYUSD",
		"OUSD",
		"pathUSD",
		"alphaUSD",
		"betaUSD",
		"thetaUSD",
		"USDC.e",
		"rUSD",
		"USDT0",
		"SBC",
	].map((symbol): [string, string] => [symbol, "USD"]),
	["GBPA", "GBP"],
	["WETH", "ETH"],
]);

/** `numerator / denominator` rounded half away from zero. `denominator` is positive. */
function divideRounded(numerator: bigint, denominator: bigint): bigint {
	const quotient = numerator / denominator;
	const remainder = numerator % denominator;
	const twice = remainder < 0n ? -2n * remainder : 2n * remainder;
	if (twice < denominator) return quotient;
	return numerator < 0n ? quotient - 1n : quotient + 1n;
}

/**
 * What the source pays over what the destination receives, in basis points of
 * the received value, rounded to two decimals. Null unless both symbols share a peg.
 */
export function spreadBps(params: {
	readonly sourceAmount: AtomicAmount;
	readonly sourceDecimals: number;
	readonly sourceSymbol: string;
	readonly fulfillmentAmount: AtomicAmount;
	readonly destinationDecimals: number;
	readonly destinationSymbol: string;
}): number | null {
	const peg = PEG_BY_SYMBOL.get(params.sourceSymbol);
	if (peg === undefined || PEG_BY_SYMBOL.get(params.destinationSymbol) !== peg) return null;
	const paid = BigInt(params.sourceAmount);
	const received = BigInt(params.fulfillmentAmount);
	if (received === 0n) return null;
	const sourceScale = 10n ** BigInt(params.sourceDecimals);
	const destinationScale = 10n ** BigInt(params.destinationDecimals);
	const hundredthsOfBps = divideRounded(
		(paid * destinationScale - received * sourceScale) * 1_000_000n,
		received * sourceScale,
	);
	return Number(hundredthsOfBps) / 100;
}
