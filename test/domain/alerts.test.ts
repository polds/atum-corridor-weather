import { describe, expect, it } from "vitest";
import { alertsFor, staleAlert } from "../../src/domain/alerts";
import { corridorId, iso, reading, tick } from "../support/readings";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const A = corridorId("eip155:1/erc20:0xaa>eip155:2/erc20:0xbb");
const B = corridorId("eip155:2/erc20:0xbb>eip155:1/erc20:0xaa");
const base = { nowMs: NOW, tickIntervalMinutes: 5, slowQuoteMs: 2500 };
const freshTick = tick("2026-11-22T11:55:00.000Z");

describe("alertsFor", () => {
	it("is quiet for a fresh tick and healthy corridors", () => {
		const alerts = alertsFor({
			...base,
			ticks: [freshTick],
			tiers: [
				{
					corridorId: A,
					latest: reading("small", "quoted", "2026-11-22T11:55:10.000Z"),
					previous: reading("small", "quoted", "2026-11-22T07:20:10.000Z"),
				},
			],
		});
		expect(alerts).toStrictEqual([]);
	});

	it("raises quotes_lost when the previous probe of a tier was quoted and the latest is not", () => {
		const alerts = alertsFor({
			...base,
			ticks: [freshTick],
			tiers: [
				{
					corridorId: A,
					latest: reading("small", "declined", "2026-11-22T11:55:10.000Z"),
					previous: reading("small", "quoted", "2026-11-22T07:20:10.000Z"),
				},
				{
					corridorId: B,
					latest: reading("small", "declined", "2026-11-22T11:55:20.000Z"),
					previous: reading("small", "declined", "2026-11-22T07:20:20.000Z"),
				},
				{
					corridorId: B,
					latest: reading("large", "quoted", "2026-11-22T11:55:30.000Z"),
					previous: null,
				},
			],
		});
		expect(alerts).toStrictEqual([
			{
				kind: "quotes_lost",
				severity: "critical",
				corridorId: A,
				message:
					"The small tier was quoted at 2026-11-22T07:20:10.000Z and was declined at 2026-11-22T11:55:10.000Z.",
				since: "2026-11-22T11:55:10.000Z",
			},
		]);
	});

	it("warns slow_quotes above the threshold and not at it", () => {
		const alerts = alertsFor({
			...base,
			ticks: [freshTick],
			tiers: [
				{
					corridorId: A,
					latest: reading("small", "quoted", "2026-11-22T11:55:10.000Z", { firstQuoteMs: 2501 }),
					previous: null,
				},
				{
					corridorId: B,
					latest: reading("small", "quoted", "2026-11-22T11:55:10.000Z", { firstQuoteMs: 2500 }),
					previous: null,
				},
			],
		});
		expect(alerts.map((alert) => [alert.kind, alert.severity, alert.corridorId])).toStrictEqual([
			["slow_quotes", "warning", A],
		]);
	});

	it("raises gateway_errors from the first of the erroring ticks in a row", () => {
		const alerts = alertsFor({
			...base,
			ticks: [
				tick("2026-11-22T11:55:00.000Z", { completed: 4, gatewayErrors: 2 }),
				tick("2026-11-22T11:50:00.000Z", { aborted: "defaults_unavailable", completed: 0 }),
				tick("2026-11-22T11:45:00.000Z", { completed: 4, gatewayErrors: 1 }),
			],
			tiers: [],
		});
		expect(alerts).toStrictEqual([
			{
				kind: "gateway_errors",
				severity: "critical",
				corridorId: null,
				message: "2 of 4 probes in the last tick were gateway errors.",
				since: "2026-11-22T11:50:00.000Z",
			},
		]);
	});

	it("raises gateway_errors when discovery failed and not when fewer than half failed", () => {
		const failed = alertsFor({
			...base,
			ticks: [tick("2026-11-22T11:55:00.000Z", { aborted: "defaults_unavailable", completed: 0 })],
			tiers: [],
		});
		expect(failed.map((alert) => alert.message)).toStrictEqual([
			"The last tick could not read /v1/defaults.",
		]);
		const fine = alertsFor({
			...base,
			ticks: [tick("2026-11-22T11:55:00.000Z", { completed: 5, gatewayErrors: 2 })],
			tiers: [],
		});
		expect(fine).toStrictEqual([]);
	});

	it("orders critical kinds before warnings", () => {
		const alerts = alertsFor({
			...base,
			ticks: [],
			tiers: [
				{
					corridorId: A,
					latest: reading("small", "quoted", "2026-11-22T11:55:10.000Z", { firstQuoteMs: 9000 }),
					previous: null,
				},
			],
		});
		expect(alerts.map((alert) => alert.kind)).toStrictEqual(["prober_stale", "slow_quotes"]);
	});
});

describe("staleAlert", () => {
	const at = (finishedAt: string | null) =>
		staleAlert({
			nowMs: NOW,
			tickIntervalMinutes: 5,
			lastTickFinishedAt: finishedAt === null ? null : iso(finishedAt),
		});

	it("is quiet up to three intervals after the last tick", () => {
		expect(at("2026-11-22T11:45:00.000Z")).toBeNull();
	});

	it("fires after three intervals, since the last finished tick", () => {
		expect(at("2026-11-22T11:44:59.999Z")).toStrictEqual({
			kind: "prober_stale",
			severity: "critical",
			corridorId: null,
			message:
				"No tick has finished since 2026-11-22T11:44:59.999Z, more than three intervals ago.",
			since: "2026-11-22T11:44:59.999Z",
		});
	});

	it("fires when no tick has ever finished", () => {
		expect(at(null)).toMatchObject({ kind: "prober_stale", since: "2026-11-22T12:00:00.000Z" });
	});
});
