import { describe, expect, it } from "vitest";
import {
	type AnnouncedAlert,
	alertKeyOf,
	isAlertKey,
	type NotificationPlan,
	planNotifications,
	renderMessage,
} from "../../src/domain/notify";
import type { Alert } from "../../src/domain/snapshot";
import { ARB_TO_BASE_USDC } from "../support/fixtures";
import { corridorId, iso } from "../support/readings";

const CORRIDOR = corridorId(ARB_TO_BASE_USDC);
const OTHER = corridorId(
	"eip155:84532/erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e>eip155:421614/erc20:0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d",
);
const NOW = iso("2026-11-22T10:37:00.000Z");

function alert(kind: Alert["kind"], extra: Partial<Alert> = {}): Alert {
	return {
		kind,
		severity: kind === "slow_quotes" ? "warning" : "critical",
		corridorId: kind === "prober_stale" || kind === "gateway_errors" ? null : CORRIDOR,
		message: `${kind} message`,
		since: iso("2026-11-22T10:30:00.000Z"),
		...extra,
	};
}

function announced(source: Alert, announcedAt = NOW): AnnouncedAlert {
	return {
		key: alertKeyOf(source),
		kind: source.kind,
		severity: source.severity,
		corridorId: source.corridorId,
		since: source.since,
		announcedAt,
	};
}

const keys = (plan: NotificationPlan) => ({
	raised: plan.raised.map(alertKeyOf),
	cleared: plan.cleared.map((row) => row.key),
});

describe("alertKeyOf", () => {
	it("is the kind and the corridor, so tiers of one corridor share a key", () => {
		expect(alertKeyOf(alert("prober_stale"))).toBe("prober_stale|");
		expect(alertKeyOf(alert("quotes_lost"))).toBe(`quotes_lost|${ARB_TO_BASE_USDC}`);
		expect(isAlertKey("quotes_lost|")).toBe(true);
		for (const bad of ["quotes_lost", "unknown|", "quotes_lost|not-a-corridor"]) {
			expect(isAlertKey(bad)).toBe(false);
		}
	});
});

describe("planNotifications", () => {
	it("raises a new alert, clears a gone one and repeats nothing still active", () => {
		const stale = alert("prober_stale");
		const lost = alert("quotes_lost");
		const errors = alert("gateway_errors");
		const plan = planNotifications({
			current: [stale, lost],
			announced: [announced(stale), announced(errors)],
			minSeverity: "critical",
		});
		expect(plan).toStrictEqual({ raised: [lost], cleared: [announced(errors)] });
	});

	it("is empty when nothing changed", () => {
		const lost = alert("quotes_lost");
		expect(
			planNotifications({ current: [lost], announced: [announced(lost)], minSeverity: "critical" }),
		).toStrictEqual({ raised: [], cleared: [] });
		expect(planNotifications({ current: [], announced: [], minSeverity: "warning" })).toStrictEqual(
			{ raised: [], cleared: [] },
		);
	});

	it("leaves out alerts below the minimum severity", () => {
		const slow = alert("slow_quotes");
		expect(
			planNotifications({ current: [slow], announced: [], minSeverity: "critical" }).raised,
		).toStrictEqual([]);
		expect(
			planNotifications({ current: [slow], announced: [], minSeverity: "warning" }).raised,
		).toStrictEqual([slow]);
	});

	it("keeps an announced alert that is still active below the minimum, and silent", () => {
		const slow = alert("slow_quotes");
		const plan = planNotifications({
			current: [slow],
			announced: [announced(slow)],
			minSeverity: "critical",
		});
		expect(plan).toStrictEqual({ raised: [], cleared: [] });
		const gone = planNotifications({
			current: [],
			announced: [announced(slow)],
			minSeverity: "critical",
		});
		expect(gone).toStrictEqual({ raised: [], cleared: [announced(slow)] });
	});

	it("raises one alert per key when several tiers of a corridor fire", () => {
		const small = alert("quotes_lost", {
			message: "small",
			since: iso("2026-11-22T10:31:00.000Z"),
		});
		const large = alert("quotes_lost", {
			message: "large",
			since: iso("2026-11-22T10:30:00.000Z"),
		});
		expect(
			planNotifications({ current: [small, large], announced: [], minSeverity: "critical" }).raised,
		).toStrictEqual([large]);
	});

	it("orders critical before warning, then by since, then by key", () => {
		const early = iso("2026-11-22T10:00:00.000Z");
		const late = iso("2026-11-22T10:20:00.000Z");
		const current = [
			alert("slow_quotes", { since: early }),
			alert("quotes_lost", { corridorId: OTHER, since: late }),
			alert("quotes_lost", { since: late }),
			alert("gateway_errors", { since: late }),
			alert("prober_stale", { since: early }),
		];
		const plan = planNotifications({ current, announced: [], minSeverity: "warning" });
		expect(keys(plan).raised).toStrictEqual([
			"prober_stale|",
			"gateway_errors|",
			`quotes_lost|${ARB_TO_BASE_USDC}`,
			`quotes_lost|${OTHER}`,
			`slow_quotes|${ARB_TO_BASE_USDC}`,
		]);
		const gone = planNotifications({
			current: [],
			announced: current.map((row) => announced(row)).reverse(),
			minSeverity: "warning",
		});
		expect(keys(gone).cleared).toStrictEqual(keys(plan).raised);
	});
});

describe("renderMessage", () => {
	const render = (plan: NotificationPlan, publicUrl: string | null = null) =>
		renderMessage({ plan, network: "testnet", generatedAt: NOW, publicUrl });

	it("opens with the unofficial line and lists what was raised and cleared", () => {
		const lost = alert("quotes_lost", { message: "The small tier was declined." });
		const message = render({ raised: [lost], cleared: [announced(alert("prober_stale"))] });
		expect(message.text.split("\n")).toStrictEqual([
			"Corridor Weather on testnet. An unofficial open-source project, not an Atum product.",
			"Raised (1)",
			`[critical] quotes_lost: ${ARB_TO_BASE_USDC}: The small tier was declined. (since 2026-11-22T10:30:00.000Z)`,
			"Cleared (1)",
			"[critical] prober_stale: network-wide (since 2026-11-22T10:30:00.000Z)",
		]);
		expect(message.json).toStrictEqual({
			source: "corridor-weather",
			unofficial: true,
			network: "testnet",
			generatedAt: NOW,
			raised: [
				{
					key: `quotes_lost|${ARB_TO_BASE_USDC}`,
					kind: "quotes_lost",
					severity: "critical",
					corridorId: ARB_TO_BASE_USDC,
					message: "The small tier was declined.",
					since: "2026-11-22T10:30:00.000Z",
				},
			],
			cleared: [
				{
					key: "prober_stale|",
					kind: "prober_stale",
					severity: "critical",
					corridorId: null,
					since: "2026-11-22T10:30:00.000Z",
					announcedAt: NOW,
				},
			],
			text: message.text,
		});
	});

	it("lists at most ten lines a section and counts the rest", () => {
		const many = (n: number) =>
			Array.from({ length: n }, (_, index) =>
				alert("quotes_lost", {
					since: iso(`2026-11-22T10:${String(index).padStart(2, "0")}:00.000Z`),
				}),
			);
		const lines = render({
			raised: many(13),
			cleared: many(10).map((row) => announced(row)),
		}).text.split("\n");
		expect(lines.filter((line) => line.startsWith("[critical]"))).toHaveLength(20);
		const more = "and 3 more, listed in the health report at /api/v1/health";
		expect(lines).toContain("Raised (13)");
		expect(lines).toContain("Cleared (10)");
		expect(lines.filter((line) => line.startsWith("and "))).toStrictEqual([more]);
		expect(lines.indexOf(more)).toBe(lines.indexOf("Raised (13)") + 11);
	});

	it("points a cut section at the health report under the public URL when one is set", () => {
		const many = Array.from({ length: 23 }, (_, index) =>
			alert("quotes_lost", {
				since: iso(`2026-11-22T10:${String(index).padStart(2, "0")}:00.000Z`),
			}),
		);
		const cut = (publicUrl: string | null) =>
			render({ raised: many, cleared: [] }, publicUrl)
				.text.split("\n")
				.filter((line) => line.startsWith("and "));
		expect(cut("https://weather.example/cw")).toStrictEqual([
			"and 13 more, listed at https://weather.example/cw/api/v1/health",
		]);
		expect(cut(null)).toStrictEqual(["and 13 more, listed in the health report at /api/v1/health"]);
	});

	it("does not point a cut cleared section at the health report, which lists active alerts only", () => {
		const many = Array.from({ length: 23 }, (_, index) =>
			announced(
				alert("quotes_lost", {
					since: iso(`2026-11-22T10:${String(index).padStart(2, "0")}:00.000Z`),
				}),
			),
		);
		const lines = render({ raised: [], cleared: many }, "https://weather.example").text.split("\n");
		expect(lines.filter((line) => line.startsWith("and "))).toStrictEqual(["and 13 more"]);
	});

	it("links the dashboard and the health check only when a public URL is set", () => {
		const plan = { raised: [alert("prober_stale")], cleared: [] };
		expect(render(plan).text).not.toMatch(/https?:/);
		expect(render(plan, "https://weather.example/cw").text.split("\n").slice(-2)).toStrictEqual([
			"Dashboard: https://weather.example/cw/",
			"Health: https://weather.example/cw/api/v1/health",
		]);
	});
});
