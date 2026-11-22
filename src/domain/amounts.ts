import { isAtomicAmount } from "./brands";
import type { AtomicAmount } from "./types";

const WHOLE_AMOUNT = /^(\d+)(?:\.(\d+))?$/;

/**
 * A whole-token decimal string ("1", "0.5", "250") in the token's smallest
 * unit. Null when the text is not a plain non-negative decimal or has more
 * fractional digits than the token has decimals.
 */
export function toAtomicAmount(whole: string, decimals: number): AtomicAmount | null {
	const match = WHOLE_AMOUNT.exec(whole);
	if (match === null || !Number.isInteger(decimals) || decimals < 0) return null;
	const [, integerPart = "", fraction = ""] = match;
	if (fraction.length > decimals) return null;
	const atomic = (
		BigInt(integerPart) * 10n ** BigInt(decimals) +
		BigInt(fraction.padEnd(decimals, "0") || "0")
	).toString();
	return isAtomicAmount(atomic) ? atomic : null;
}
