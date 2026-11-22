import { spreadBps } from "./spread";
import type {
	AtomicAmount,
	DeclineEntry,
	IsoTimestamp,
	ProbeOutcome,
	ProbeTarget,
	QuoteObservation,
} from "./types";

export interface SeenQuote {
	readonly quoteId: string;
	readonly settlerAddress: string;
	readonly sourceAmount: AtomicAmount;
	readonly awardDeadline: IsoTimestamp;
	/** Epoch ms of the poll response that first listed this quote. Null when it was not observed arriving. */
	readonly firstSeenMs: number | null;
}

/** The last status the probe read, with the quotes it lists. */
export interface FinalStatus {
	/** Open set: `collecting`, `ready`, `awarded`, `expired`, or a value the gateway adds later. */
	readonly status: string;
	readonly quotes: readonly SeenQuote[];
	/** Null when the response had no `decline_summary`. */
	readonly declines: readonly DeclineEntry[] | null;
	/** Null when the response had no `requested_count`. Never read as zero. */
	readonly requestedCount: number | null;
}

function observe(target: ProbeTarget, quote: SeenQuote): QuoteObservation {
	const { source, destination } = target.corridor;
	return {
		quoteId: quote.quoteId,
		settlerAddress: quote.settlerAddress,
		sourceAmount: quote.sourceAmount,
		awardDeadline: quote.awardDeadline,
		spreadBps: spreadBps({
			sourceAmount: quote.sourceAmount,
			sourceDecimals: source.decimals,
			sourceSymbol: source.symbol,
			fulfillmentAmount: target.fulfillmentAmount,
			destinationDecimals: destination.decimals,
			destinationSymbol: destination.symbol,
		}),
		priceHoldMs:
			quote.firstSeenMs === null ? null : Date.parse(quote.awardDeadline) - quote.firstSeenMs,
	};
}

/**
 * A batch still `collecting` is `incomplete`. Otherwise any quote makes it
 * `quoted`, any decline makes it `declined`, and nothing at all is `silent`.
 */
export function classifyOutcome(target: ProbeTarget, final: FinalStatus): ProbeOutcome {
	if (final.status === "collecting") return { kind: "incomplete" };
	const declines = final.declines ?? [];
	const [firstQuote, ...otherQuotes] = final.quotes.map((quote) => observe(target, quote));
	if (firstQuote !== undefined) {
		return {
			kind: "quoted",
			quotes: [firstQuote, ...otherQuotes],
			declines,
			requestedCount: final.requestedCount,
		};
	}
	const [firstDecline, ...otherDeclines] = declines;
	if (firstDecline !== undefined) {
		return {
			kind: "declined",
			declines: [firstDecline, ...otherDeclines],
			requestedCount: final.requestedCount,
		};
	}
	return { kind: "silent", requestedCount: final.requestedCount };
}
