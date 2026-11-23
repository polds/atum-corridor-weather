/**
 * Retention by day. The maintenance cron reduces each complete UTC day of probes
 * to daily figures, then deletes at most one expired day of each kind of row.
 * See docs/DESIGN.md, "Retention and long history".
 */
import type { Brand, Network, ProbeId } from "./types";

/** A UTC calendar day, `YYYY-MM-DD`. A probe and a tick belong to the day of their slot start. */
export type UtcDay = Brand<string, "UtcDay">;

const DAY_MS = 86_400_000;
const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Days of figures one maintenance run writes at most. */
export const FIGURES_DAYS_PER_RUN = 3;

/**
 * A tick that started before midnight can still be storing probes this long after
 * it: the Cron Trigger duration limit. A day is complete once this has passed.
 */
export const TICK_MAX_MS = 15 * 60_000;

export function isUtcDay(value: string): value is UtcDay {
	if (!UTC_DAY.test(value)) return false;
	const ms = Date.parse(`${value}T00:00:00.000Z`);
	return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(value);
}

export function dayAt(epochMs: number): UtcDay {
	const day = new Date(epochMs).toISOString().slice(0, 10);
	if (!isUtcDay(day)) throw new RangeError(`${epochMs} has no four-digit-year day`);
	return day;
}

export function dayStartMs(day: UtcDay): number {
	return Date.parse(`${day}T00:00:00.000Z`);
}

export function addDays(day: UtcDay, days: number): UtcDay {
	return dayAt(dayStartMs(day) + days * DAY_MS);
}

/** Days from `from` to `to`, both included. Empty when `to` is before `from`. */
export function daysFrom(from: UtcDay, to: UtcDay): UtcDay[] {
	const days: UtcDay[] = [];
	for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
	return days;
}

/** Whole days from `from` to `to`. */
function daysBetween(from: UtcDay, to: UtcDay): number {
	return Math.round((dayStartMs(to) - dayStartMs(from)) / DAY_MS);
}

/** `20261122` from `2026-11-22`: the day as a probe id spells it. */
function compactDay(day: UtcDay): string {
	return day.replaceAll("-", "");
}

/**
 * The probe ids of `network`, or of one day of it, as a half-open text range.
 * A probe id is `cw1.{network}.{yyyymmdd}T{hhmm}Z...` (`probeIdFor`), so the ids
 * of one day sort together, and a day of probes is one key range in every table
 * keyed by probe id.
 */
export function probeIdRange(
	network: Network,
	day: UtcDay | null,
): { readonly from: string; readonly to: string } {
	const prefix = `cw1.${network}.`;
	if (day === null) return { from: prefix, to: `cw1.${network}/` };
	return { from: `${prefix}${compactDay(day)}`, to: `${prefix}${compactDay(addDays(day, 1))}` };
}

/** The day of a probe id's slot start. Null when the id is not in the `probeIdFor` format. */
export function dayOfProbeId(id: ProbeId | string): UtcDay | null {
	const match = /^cw1\.[a-z]+\.(\d{4})(\d{2})(\d{2})T\d{4}Z\./.exec(id);
	if (match === null) return null;
	const day = `${match[1]}-${match[2]}-${match[3]}`;
	return isUtcDay(day) ? day : null;
}

/** How many days each kind of row is kept. Every value is at least 1. */
export interface Retention {
	readonly rawDays: number;
	readonly probeDays: number;
	readonly dailyDays: number;
}

/** The oldest day the store holds of each kind of row. Null when it holds none. */
export interface OldestDays {
	readonly probes: UtcDay | null;
	readonly ticks: UtcDay | null;
	readonly raw: UtcDay | null;
	readonly figures: UtcDay | null;
}

/** The oldest stored day of one kind of row, when it is past its retention. */
export interface Expiry {
	/** The day to delete. Null when the oldest stored day is still kept. */
	readonly day: UtcDay | null;
	/**
	 * Calendar days from the oldest stored day to the newest expired one: the
	 * days waiting. 1 in steady state; more means one run a day cannot keep up.
	 */
	readonly waiting: number;
}

/**
 * Day `D` is past a retention of `keepDays` on day `T` when `D < T - keepDays`:
 * the store keeps today and the `keepDays` days before it.
 */
export function expiryOf(oldest: UtcDay | null, keepDays: number, nowMs: number): Expiry {
	if (oldest === null) return { day: null, waiting: 0 };
	const newestExpired = addDays(dayAt(nowMs), -keepDays - 1);
	const waiting = Math.max(0, daysBetween(oldest, newestExpired) + 1);
	return { day: waiting > 0 ? oldest : null, waiting };
}

/** The earlier of two days. Null only when both are. */
export function earlierDay(a: UtcDay | null, b: UtcDay | null): UtcDay | null {
	if (a === null) return b;
	return b === null || a <= b ? a : b;
}

/**
 * Complete days that may lack daily figures, oldest first: from the oldest day
 * that has probes to the last complete day. A day is complete `TICK_MAX_MS`
 * after it ends, when no tick of it can still be storing probes.
 */
export function figureCandidates(oldestProbeDay: UtcDay | null, nowMs: number): UtcDay[] {
	if (oldestProbeDay === null) return [];
	return daysFrom(oldestProbeDay, addDays(dayAt(nowMs - TICK_MAX_MS), -1));
}

/** The days of daily figures a history serves: the `dailyDays` days before today. */
export function figureDaysAt(nowMs: number, dailyDays: number): readonly UtcDay[] {
	const today = dayAt(nowMs);
	return daysFrom(addDays(today, -dailyDays), addDays(today, -1));
}
