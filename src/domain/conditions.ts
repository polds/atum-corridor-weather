import type { Condition } from "./snapshot";
import type { ProbeOutcomeKind } from "./types";

/** From the latest reading of each probed tier. No readings is `unknown`. */
export function conditionOf(latest: readonly { readonly outcome: ProbeOutcomeKind }[]): Condition {
	if (latest.length === 0) return "unknown";
	const quoted = latest.filter((reading) => reading.outcome === "quoted").length;
	if (quoted === latest.length) return "fair";
	return quoted > 0 ? "cloudy" : "stormy";
}
