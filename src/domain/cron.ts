const DIGITS = /^\d+$/;
const STEP = /^\*\/(\d+)$/;

/** `*` is every unit, and a step of n is every n units when n divides the cycle evenly. */
function everyN(field: string, cycle: number): number | null {
	if (field === "*") return 1;
	const n = Number(STEP.exec(field)?.[1]);
	return Number.isInteger(n) && n >= 1 && n < cycle && cycle % n === 0 ? n : null;
}

function isValue(field: string, max: number): boolean {
	return DIGITS.test(field) && Number(field) <= max;
}

/**
 * The interval in minutes at which a five-field cron expression fires, or null
 * when it does not fire at one fixed interval. The prober places each tick in a
 * slot of that length, so the probe cron must be one of these shapes:
 * every n minutes, hourly at one minute, every n hours at one minute, or daily at one time.
 * A step counts only when it divides the hour or the day, because a step of 45
 * minutes fires at :00 and :45, 45 and then 15 minutes apart.
 */
export function cronIntervalMinutes(expression: string): number | null {
	const [minute, hour, dayOfMonth, month, dayOfWeek, ...rest] = expression.split(" ");
	if (minute === undefined || hour === undefined || rest.length > 0) return null;
	if (dayOfMonth !== "*" || month !== "*" || dayOfWeek !== "*") return null;
	if (hour === "*") return everyN(minute, 60) ?? (isValue(minute, 59) ? 60 : null);
	if (!isValue(minute, 59)) return null;
	const hours = everyN(hour, 24);
	if (hours !== null) return hours * 60;
	return isValue(hour, 23) ? 1440 : null;
}
