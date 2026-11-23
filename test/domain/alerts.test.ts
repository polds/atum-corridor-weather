import { describe, expect, it } from "vitest";
import { alertsFor, staleAlert } from "../../src/domain/alerts";
import { corridorId, iso, reading, tick } from "../support/readings";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const A = corridorId("eip155:1/erc20:0xaa>eip155:2/erc20:0xbb");
const B = corridorId("eip155:2/erc20:0xbb>eip155:1/erc20:0xaa");
const base = { nowMs: NOW, publishIntervalMinutes: 5, slowQuoteMs: 2500 };
const freshTick = tick("2026-11-22T11:55:00.000Z");

describe("alertsFor", () => {
	it("is quiet for a fresh tick and healthy corridors", () => {
		const alerts = alertsFor({
			...base,
			lastTick: freshTick,
			errorRunStart: null,
			lastQuotes: [],
			tiers: [
				{
					corridorId: A,
					latest: reading("small", "quoted", "2026-11-22T11:55:10.000Z"),
				},
			],
		});
		expect(alerts).toStrictEqual([]);
	});

	describe("quotes_lost", () => {
		const lastQuote = (quotedAt: string, firstUnquotedAt: string | null = null) => ({
			corridorId: A,
			quotedAt: iso(quotedAt),
			firstUnquotedAt: firstUnquotedAt === null ? null : iso(firstUnquotedAt),
		});
		const lost = (params: {
			readonly tiers: Parameters<typeof alertsFor>[0]["tiers"];
			readonly lastQuotes: Parameters<typeof alertsFor>[0]["lastQuotes"];
		}) =>
			alertsFor({ ...base, lastTick: freshTick, errorRunStart: null, ...params }).filter(
				(alert) => alert.kind === "quotes_lost",
			);

		it("is active while no probed tier is quoted and the last quote is recent", () => {
			expect(
				lost({
					tiers: [
						{ corridorId: A, latest: reading("small", "declined", "2026-11-22T11:55:10.000Z") },
						{ corridorId: A, latest: reading("large", "silent", "2026-11-22T11:50:10.000Z") },
					],
					lastQuotes: [lastQuote("2026-11-22T07:20:10.000Z", "2026-11-22T07:25:10.000Z")],
				}),
			).toStrictEqual([
				{
					kind: "quotes_lost",
					severity: "critical",
					corridorId: A,
					message: "No tier is quoted now. The last quote was at 2026-11-22T07:20:10.000Z.",
					since: "2026-11-22T07:25:10.000Z",
				},
			]);
		});

		it("is quiet while one tier still quotes", () => {
			expect(
				lost({
					tiers: [
						{ corridorId: A, latest: reading("small", "declined", "2026-11-22T11:55:10.000Z") },
						{ corridorId: A, latest: reading("large", "quoted", "2026-11-22T11:50:10.000Z") },
					],
					lastQuotes: [lastQuote("2026-11-22T11:50:10.000Z")],
				}),
			).toStrictEqual([]);
		});

		it("is quiet for a corridor never quoted", () => {
			expect(
				lost({
					tiers: [
						{ corridorId: B, latest: reading("small", "declined", "2026-11-22T11:55:20.000Z") },
					],
					lastQuotes: [],
				}),
			).toStrictEqual([]);
		});

		it("ends 7 days after the last quote", () => {
			const tiers = [
				{ corridorId: A, latest: reading("small", "declined", "2026-11-22T11:55:10.000Z") },
			];
			expect(lost({ tiers, lastQuotes: [lastQuote("2026-11-15T12:00:00.000Z")] })).toHaveLength(1);
			expect(lost({ tiers, lastQuotes: [lastQuote("2026-11-15T11:59:59.999Z")] })).toStrictEqual(
				[],
			);
		});

		it("is active since the last quote when no later probe is known", () => {
			const [alert] = lost({
				tiers: [
					{ corridorId: A, latest: reading("small", "declined", "2026-11-22T11:55:10.000Z") },
				],
				lastQuotes: [lastQuote("2026-11-22T07:20:10.000Z")],
			});
			expect(alert?.since).toBe("2026-11-22T07:20:10.000Z");
		});
	});

	it("warns slow_quotes above the threshold and not at it", () => {
		const alerts = alertsFor({
			...base,
			lastTick: freshTick,
			errorRunStart: null,
			lastQuotes: [],
			tiers: [
				{
					corridorId: A,
					latest: reading("small", "quoted", "2026-11-22T11:55:10.000Z", { firstQuoteMs: 2501 }),
				},
				{
					corridorId: B,
					latest: reading("small", "quoted", "2026-11-22T11:55:10.000Z", { firstQuoteMs: 2500 }),
				},
			],
		});
		expect(alerts.map((alert) => [alert.kind, alert.severity, alert.corridorId])).toStrictEqual([
			["slow_quotes", "warning", A],
		]);
	});

	it("raises gateway_errors since the start of the failing run", () => {
		const alerts = alertsFor({
			...base,
			lastTick: tick("2026-11-22T11:55:00.000Z", { completed: 4, gatewayErrors: 2 }),
			errorRunStart: iso("2026-11-22T11:50:00.000Z"),
			tiers: [],
			lastQuotes: [],
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
			lastTick: tick("2026-11-22T11:55:00.000Z", { aborted: "defaults_unavailable", completed: 0 }),
			errorRunStart: iso("2026-11-22T11:55:00.000Z"),
			tiers: [],
			lastQuotes: [],
		});
		expect(failed.map((alert) => alert.message)).toStrictEqual([
			"The last tick could not read /v1/defaults.",
		]);
		const fine = alertsFor({
			...base,
			lastTick: tick("2026-11-22T11:55:00.000Z", { completed: 5, gatewayErrors: 2 }),
			errorRunStart: null,
			tiers: [],
			lastQuotes: [],
		});
		expect(fine).toStrictEqual([]);
	});

	it("orders critical kinds before warnings", () => {
		const alerts = alertsFor({
			...base,
			lastTick: null,
			errorRunStart: null,
			lastQuotes: [],
			tiers: [
				{
					corridorId: A,
					latest: reading("small", "quoted", "2026-11-22T11:55:10.000Z", { firstQuoteMs: 9000 }),
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
			publishIntervalMinutes: 5,
			lastTickFinishedAt: finishedAt === null ? null : iso(finishedAt),
		});

	it("is quiet up to three publish intervals after the last tick", () => {
		expect(at("2026-11-22T11:45:00.000Z")).toBeNull();
	});

	it("fires after three publish intervals, since the last finished tick", () => {
		expect(at("2026-11-22T11:44:59.999Z")).toStrictEqual({
			kind: "prober_stale",
			severity: "critical",
			corridorId: null,
			message:
				"No tick has finished since 2026-11-22T11:44:59.999Z, more than three publish intervals ago.",
			since: "2026-11-22T11:44:59.999Z",
		});
	});

	it("fires when no tick has ever finished", () => {
		expect(at(null)).toMatchObject({ kind: "prober_stale", since: "2026-11-22T12:00:00.000Z" });
	});
});
