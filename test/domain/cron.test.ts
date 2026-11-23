import { describe, expect, it } from "vitest";
import { cronIntervalMinutes } from "../../src/domain/cron";

describe("cronIntervalMinutes", () => {
	it.each([
		["* * * * *", 1],
		["*/1 * * * *", 1],
		["*/5 * * * *", 5],
		["*/10 * * * *", 10],
		["*/30 * * * *", 30],
		["0 * * * *", 60],
		["17 * * * *", 60],
		["0 */1 * * *", 60],
		["0 */6 * * *", 360],
		["30 */12 * * *", 720],
		["0 0 * * *", 1440],
		["45 13 * * *", 1440],
	])("reads %s as every %i minutes", (expression, minutes) => {
		expect(cronIntervalMinutes(expression)).toBe(minutes);
	});

	it.each([
		["a step that does not divide the hour", "*/45 * * * *"],
		["a step of a whole hour", "*/60 * * * *"],
		["a step of zero", "*/0 * * * *"],
		["a list of minutes", "5,35 * * * *"],
		["a range of minutes", "0-30 * * * *"],
		["a ranged step", "2-59/10 * * * *"],
		["every minute of some hours", "* */2 * * *"],
		["a step that does not divide the day", "0 */5 * * *"],
		["a minute past 59", "60 * * * *"],
		["an hour past 23", "0 24 * * *"],
		["a day of the month", "0 0 1 * *"],
		["a month", "0 0 * 1 *"],
		["a day of the week", "0 0 * * mon"],
		["four fields", "*/10 * * *"],
		["six fields", "*/10 * * * * *"],
		["nothing", ""],
	])("finds no fixed interval in %s", (_name, expression) => {
		expect(cronIntervalMinutes(expression)).toBeNull();
	});
});
