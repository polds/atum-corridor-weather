/**
 * Pure display formatting. No DOM, no clock: callers pass `nowMs`.
 */

const DIGITS = /^\d+$/;

function groupThousands(integer: string): string {
	return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Formats an atomic amount (a digit string in the token's smallest unit) as a
 * decimal string, using BigInt so no precision is lost. Rounds half up to
 * `maxFractionDigits` and drops trailing zeros.
 *
 * formatAtomicAmount("25003100", 6) === "25.0031"
 */
export function formatAtomicAmount(
	atomic: string,
	decimals: number,
	maxFractionDigits = 6,
): string {
	if (!DIGITS.test(atomic) || !Number.isInteger(decimals) || decimals < 0) return atomic;
	let value = BigInt(atomic);
	let scale = decimals;
	if (decimals > maxFractionDigits) {
		const divisor = 10n ** BigInt(decimals - maxFractionDigits);
		const rounded = (value + divisor / 2n) / divisor;
		if (rounded === 0n && value > 0n) return `<${formatAtomicAmount("1", maxFractionDigits)}`;
		value = rounded;
		scale = maxFractionDigits;
	}
	const base = 10n ** BigInt(scale);
	const integer = groupThousands((value / base).toString());
	const fraction = (value % base).toString().padStart(scale, "0").replace(/0+$/, "");
	return fraction === "" ? integer : `${integer}.${fraction}`;
}

const bpsFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** "12.5 bps". Null means the spread is not defined, for example across pegs. */
export function formatBps(bps: number | null): string {
	return bps === null ? "n/a" : `${bpsFormat.format(bps)} bps`;
}

/** The bare number for tight spaces such as a matrix cell. */
export function formatBpsShort(bps: number): string {
	return bpsFormat.format(bps);
}

export function formatCount(n: number, singular: string, plural = `${singular}s`): string {
	return `${n.toLocaleString("en-US")} ${n === 1 ? singular : plural}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A coarse duration: "45 s", "12 min", "3 h 20 min", "2 days". */
export function formatDuration(ms: number): string {
	const abs = Math.max(0, ms);
	if (abs < MINUTE) return `${Math.round(abs / 1000)} s`;
	if (abs < HOUR) return `${Math.round(abs / MINUTE)} min`;
	if (abs < 10 * HOUR) {
		const h = Math.floor(abs / HOUR);
		const m = Math.round((abs - h * HOUR) / MINUTE);
		return m === 0 || m === 60 ? `${m === 60 ? h + 1 : h} h` : `${h} h ${m} min`;
	}
	if (abs < 2 * DAY) return `${Math.round(abs / HOUR)} h`;
	return formatCount(Math.round(abs / DAY), "day");
}

/** "4 min ago". A timestamp from the future (clock skew) reads "just now". */
export function formatAge(iso: string, nowMs: number): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return "at an unknown time";
	const ms = nowMs - t;
	if (ms < 45_000) return "just now";
	return `${formatDuration(ms)} ago`;
}

/** "2026-11-22 10:42 UTC". */
export function formatUtc(iso: string): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return iso;
	return `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** "850 ms", "2.4 s". */
export function formatMs(ms: number | null): string {
	if (ms === null) return "n/a";
	return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** "30 probes every 5 minutes, one sweep every 4.6 hours". */
export function formatCadence(input: {
	readonly probesPerTick: number;
	readonly sweepHours: number;
	readonly tickIntervalMinutes: number;
}): string {
	const probes = formatCount(input.probesPerTick, "probe");
	const every =
		input.tickIntervalMinutes === 1 ? "every minute" : `every ${input.tickIntervalMinutes} minutes`;
	const sweep =
		input.sweepHours < 1
			? formatCount(Math.round(input.sweepHours * 60), "minute")
			: `${bpsFormat.format(input.sweepHours)} ${input.sweepHours === 1 ? "hour" : "hours"}`;
	return `${probes} ${every}, one sweep every ${sweep}`;
}

const dayFormat = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	timeZone: "UTC",
});

/** "Nov 20", in UTC so axis ticks line up with UTC midnight. */
export function formatDay(ms: number): string {
	return dayFormat.format(new Date(ms));
}

/** "Nov 20, 14:05 UTC". */
export function formatDayTime(ms: number): string {
	return `${formatDay(ms)}, ${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

/** Turns a gateway reason code into words: "INSUFFICIENT_LIQUIDITY" -> "Insufficient liquidity". */
export function humanizeCode(code: string): string {
	const words = code.toLowerCase().replace(/_/g, " ").trim();
	return words === "" ? code : words.charAt(0).toUpperCase() + words.slice(1);
}
