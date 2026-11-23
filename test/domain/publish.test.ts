import { describe, expect, it } from "vitest";
import {
	buildHealth,
	buildHistory,
	buildMetrics,
	buildSnapshot,
	readingOf,
} from "../../src/domain/publish";
import { probeTargets, slotAt } from "../../src/domain/schedule";
import type { ProbeRecord, QuoteObservation } from "../../src/domain/types";
import { ARB_TO_BASE_USDC, corridorById, testnetCorridors } from "../support/fixtures";
import { probeIdOf } from "../support/ids";
import { atomic, corridorId, iso, reading, tick } from "../support/readings";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const corridor = corridorById(ARB_TO_BASE_USDC);
const reverse = corridorById(
	"eip155:84532/erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e>eip155:421614/erc20:0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d",
);
const ARB = corridorId(ARB_TO_BASE_USDC);

function observation(settler: string, amount: string, spread: number | null, hold: number) {
	return {
		quoteId: `q-${amount}`,
		settlerAddress: settler,
		sourceAmount: atomic(amount),
		awardDeadline: iso("2026-11-22T11:56:00.000Z"),
		spreadBps: spread,
		priceHoldMs: hold,
	} satisfies QuoteObservation;
}

describe("readingOf", () => {
	const [target] = probeTargets([corridor], { typical: "25" });
	if (target === undefined) throw new Error("no target");
	const probe: ProbeRecord = {
		id: probeIdOf("cw1.testnet.20261122T1155Z.7ae33acb9dd6.typical"),
		slot: slotAt({ network: "testnet", epochMs: NOW - 300_000, intervalMinutes: 5 }),
		target,
		startedAt: iso("2026-11-22T11:55:01.000Z"),
		quoteRequestId: "qr_1",
		idempotentReplay: false,
		outcome: {
			kind: "quoted",
			quotes: [
				observation("0xAbC0000000000000000000000000000000000001", "25010000", 4, 59_000),
				observation("0xabc0000000000000000000000000000000000001", "25005000", 2, 58_000),
				observation("0xdef0000000000000000000000000000000000002", "25020000", 8, 61_000),
			],
			declines: [{ reason: "INTERNAL", retryClassification: "RETRY_AFTER_DELAY", count: 1 }],
			requestedCount: 4,
		},
		timings: { createLatencyMs: 64, firstQuoteMs: 594, readyMs: 3232 },
		raw: [],
	};

	it("counts distinct operators and keeps the best and worst price", () => {
		expect(readingOf(probe)).toStrictEqual({
			tier: "typical",
			fulfillmentAmount: "25000000",
			probedAt: "2026-11-22T11:55:01.000Z",
			outcome: "quoted",
			quoteCount: 3,
			operatorCount: 2,
			bestSourceAmount: "25005000",
			bestSpreadBps: 2,
			worstSpreadBps: 8,
			firstQuoteMs: 594,
			readyMs: 3232,
			minPriceHoldMs: 58_000,
			declines: [{ reason: "INTERNAL", retryClassification: "RETRY_AFTER_DELAY", count: 1 }],
		});
	});

	it("names no operator", () => {
		expect(JSON.stringify(readingOf(probe)).toLowerCase()).not.toContain("0xabc0");
	});
});

describe("buildSnapshot", () => {
	const snapshot = buildSnapshot({
		network: "testnet",
		nowMs: NOW,
		tickIntervalMinutes: 5,
		publishIntervalMinutes: 5,
		probesPerTick: 30,
		slowQuoteMs: 2500,
		tierAmounts: { small: "1", typical: "25", large: "250" },
		corridors: testnetCorridors,
		tiers: [
			{
				corridorId: ARB,
				latest: reading("small", "quoted", "2026-11-22T11:55:10.000Z"),
			},
			{
				corridorId: ARB,
				latest: reading("large", "declined", "2026-11-22T11:50:10.000Z"),
			},
		],
		lastQuotes: [],
		lastTick: tick("2026-11-22T11:55:00.000Z"),
		errorRunStart: null,
	});

	it("lists the configured tiers in small, typical, large order", () => {
		expect(snapshot.tiers).toStrictEqual(["small", "typical", "large"]);
		const two = buildSnapshot({
			network: "testnet",
			nowMs: NOW,
			tickIntervalMinutes: 5,
			publishIntervalMinutes: 5,
			probesPerTick: 30,
			slowQuoteMs: 2500,
			tierAmounts: { large: "250", small: "1" },
			corridors: testnetCorridors,
			tiers: [],
			lastQuotes: [],
			lastTick: null,
			errorRunStart: null,
		});
		expect(two.tiers).toStrictEqual(["small", "large"]);
	});

	it("reports the cadence of a full sweep", () => {
		expect(snapshot.cadence).toStrictEqual({ probesPerTick: 30, sweepHours: 4.6 });
		expect(snapshot.lastTick?.slotStart).toBe("2026-11-22T11:55:00.000Z");
		expect(snapshot.generatedAt).toBe("2026-11-22T12:00:00.000Z");
	});

	it("counts prober_stale in publish intervals, which it publishes with the tick interval", () => {
		const at = (publishIntervalMinutes: number) =>
			buildSnapshot({
				network: "testnet",
				nowMs: NOW,
				tickIntervalMinutes: 2,
				publishIntervalMinutes,
				probesPerTick: 6,
				slowQuoteMs: 2500,
				tierAmounts: { small: "1" },
				corridors: [corridor],
				tiers: [],
				lastQuotes: [],
				// 24 minutes before NOW: twelve ticks, but under three 10-minute publishes.
				lastTick: tick("2026-11-22T11:35:00.000Z"),
				errorRunStart: null,
			});
		expect(at(10)).toMatchObject({
			tickIntervalMinutes: 2,
			publishIntervalMinutes: 10,
			alerts: [],
		});
		expect(at(2).alerts.map((alert) => alert.kind)).toStrictEqual(["prober_stale"]);
	});

	it("labels every asset's chain", () => {
		expect(snapshot.assets).toHaveLength(24);
		expect(snapshot.assets.find((asset) => asset.chainId === "eip155:421614")?.chainLabel).toBe(
			"Arbitrum Sepolia",
		);
		expect(snapshot.assets.find((asset) => asset.chainId.startsWith("solana:"))?.chainLabel).toBe(
			"Solana Devnet",
		);
	});

	it("gives each corridor a condition from its latest tier readings", () => {
		const arb = snapshot.corridors.find((entry) => entry.id === ARB);
		expect(arb?.condition).toBe("cloudy");
		expect(arb?.lastProbedAt).toBe("2026-11-22T11:55:10.000Z");
		expect(arb?.tiers.map((entry) => entry.tier)).toStrictEqual(["small", "large"]);
		expect(snapshot.corridors.find((entry) => entry.id === reverse.id)).toMatchObject({
			condition: "unknown",
			lastProbedAt: null,
			tiers: [],
		});
		expect(snapshot.alerts).toStrictEqual([]);
	});
});

describe("buildHistory", () => {
	it("lists points oldest first, small before large within one time", () => {
		const history = buildHistory({
			network: "testnet",
			corridorId: ARB,
			nowMs: NOW,
			days: 7,
			readings: [
				reading("large", "declined", "2026-11-22T11:55:10.000Z"),
				reading("small", "quoted", "2026-11-21T11:55:10.000Z"),
				reading("small", "quoted", "2026-11-22T11:55:10.000Z"),
			],
		});
		expect(history.points.map((point) => [point.probedAt, point.tier])).toStrictEqual([
			["2026-11-21T11:55:10.000Z", "small"],
			["2026-11-22T11:55:10.000Z", "small"],
			["2026-11-22T11:55:10.000Z", "large"],
		]);
		expect(history).toMatchObject({
			schemaVersion: 1,
			network: "testnet",
			corridorId: ARB,
			days: 7,
		});
	});
});

describe("buildHealth", () => {
	const snapshot = buildSnapshot({
		network: "testnet",
		nowMs: NOW,
		tickIntervalMinutes: 5,
		publishIntervalMinutes: 5,
		probesPerTick: 30,
		slowQuoteMs: 100,
		tierAmounts: { small: "1" },
		corridors: [corridor],
		tiers: [
			{
				corridorId: ARB,
				latest: reading("small", "quoted", "2026-11-22T11:55:10.000Z"),
			},
		],
		lastQuotes: [],
		lastTick: tick("2026-11-22T11:55:00.000Z"),
		errorRunStart: null,
	});

	it("is ok with only a warning active", () => {
		const health = buildHealth({
			network: "testnet",
			nowMs: NOW,
			publishIntervalMinutes: 5,
			snapshot,
		});
		expect(health.status).toBe("ok");
		expect(health.alerts.map((alert) => alert.kind)).toStrictEqual(["slow_quotes"]);
		expect(health.lastTickFinishedAt).toBe("2026-11-22T11:56:00.000Z");
	});

	it("recomputes prober_stale at request time", () => {
		const later = Date.parse("2026-11-22T12:12:00.000Z");
		const health = buildHealth({
			network: "testnet",
			nowMs: later,
			publishIntervalMinutes: 5,
			snapshot,
		});
		expect(health.status).toBe("alerting");
		expect(health.alerts.map((alert) => alert.kind)).toStrictEqual(["prober_stale", "slow_quotes"]);
		expect(health.checkedAt).toBe("2026-11-22T12:12:00.000Z");
	});

	it("alerts when nothing was ever published", () => {
		const health = buildHealth({
			network: "testnet",
			nowMs: NOW,
			publishIntervalMinutes: 5,
			snapshot: null,
		});
		expect(health).toMatchObject({ status: "alerting", lastTickFinishedAt: null });
	});

	it("exposes the same signals as Prometheus gauges", () => {
		const health = buildHealth({
			network: "testnet",
			nowMs: NOW,
			publishIntervalMinutes: 5,
			snapshot,
		});
		const lines = buildMetrics({ network: "testnet", snapshot, health }).split("\n");
		const labels = `network="testnet",corridor="${ARB}",tier="small"`;
		expect(lines).toContain(`corridor_weather_quote_count{${labels}} 1`);
		expect(lines).toContain(`corridor_weather_operator_count{${labels}} 1`);
		expect(lines).toContain(`corridor_weather_best_spread_bps{${labels}} 2`);
		expect(lines).toContain(`corridor_weather_first_quote_ms{${labels}} 600`);
		expect(lines).toContain(`corridor_weather_last_probe_timestamp_seconds{${labels}} 1795348510`);
		expect(lines).toContain('corridor_weather_last_tick_completed{network="testnet"} 4');
		expect(lines).toContain('corridor_weather_last_tick_aborted{network="testnet"} 0');
		expect(lines).toContain(
			'corridor_weather_alert{network="testnet",kind="slow_quotes",severity="warning"} 1',
		);
		expect(lines).toContain(
			'corridor_weather_alert{network="testnet",kind="quotes_lost",severity="critical"} 0',
		);
		expect(lines).toContain("# TYPE corridor_weather_quote_count gauge");
	});

	it("has no corridor series before the first snapshot", () => {
		const health = buildHealth({
			network: "testnet",
			nowMs: NOW,
			publishIntervalMinutes: 5,
			snapshot,
		});
		const text = buildMetrics({ network: "testnet", snapshot: null, health });
		expect(text).not.toContain("corridor_weather_quote_count{");
		expect(text).toContain('corridor_weather_alert{network="testnet",kind="prober_stale"');
	});
});
