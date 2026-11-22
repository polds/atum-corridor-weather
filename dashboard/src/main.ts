import "./styles.css";
import type {
	Alert,
	Condition,
	CorridorConditions,
	CorridorHistory,
	Snapshot,
	SnapshotAsset,
} from "../../src/domain/snapshot";
import { declineChart, type LineSeries, lineChart, sizeChart } from "./charts";
import { h, hideTip, icon, showTip, tipRow } from "./dom";
import {
	formatAge,
	formatAtomicAmount,
	formatBps,
	formatBpsShort,
	formatCadence,
	formatCount,
	formatDayTime,
	formatDuration,
	formatMs,
	formatUtc,
	humanizeCode,
} from "./format";
import {
	assetName,
	type Board,
	buildBoard,
	CONDITION_TEXT,
	CONDITIONS,
	conditionCounts,
	corridorHref,
	type Filter,
	historyUrl,
	isStale,
	matchesFilter,
	OUTCOME_TEXT,
	OUTCOMES,
	type Parsed,
	parseHistory,
	parseRoute,
	parseSnapshot,
	type Route,
	snapshotAgeMs,
	summarizeCorridor,
	TIERS,
	tiersInOrder,
} from "./model";
import {
	declineBuckets,
	declineReasons,
	operatorSeries,
	outcomeTallies,
	priceBySize,
	RETRY_AFTER_DELAY,
	spreadSeries,
} from "./series";

const SNAPSHOT_URL = "/api/v1/snapshot.json";
const HISTORY_DAYS = 7;

type Load =
	| { readonly kind: "loading" }
	| { readonly kind: "missing" }
	| { readonly kind: "failed"; readonly reason: string }
	| { readonly kind: "ready"; readonly board: Board; readonly refreshError: string | null };

type View = "matrix" | "list";

interface State {
	load: Load;
	filter: Filter;
	view: View;
	route: Route;
	/** The matrix cell that holds the roving tab stop. */
	activeCell: string | null;
	overviewScroll: number;
	/** Source assets whose group the reader opened in the list view. */
	openGroups: Set<string>;
}

const narrow = window.matchMedia("(max-width: 760px)");

const state: State = {
	load: { kind: "loading" },
	filter: { text: "", conditions: new Set() },
	view: narrow.matches ? "list" : "matrix",
	route: parseRoute(window.location.hash),
	activeCell: null,
	overviewScroll: 0,
	openGroups: new Set(),
};

const main = byId("main");
const banners = byId("banners");
const networkPill = byId("network");
let cleanups: (() => void)[] = [];

function byId(id: string): HTMLElement {
	const el = document.getElementById(id);
	if (el === null) throw new Error(`#${id} is missing from index.html`);
	return el;
}

// ---------------------------------------------------------------------------
// Fetching

type Fetched =
	| { kind: "ok"; json: unknown }
	| { kind: "missing" }
	| { kind: "failed"; reason: string };

async function fetchJson(url: string): Promise<Fetched> {
	try {
		const res = await fetch(url, { headers: { accept: "application/json" }, cache: "no-cache" });
		if (!res.ok) {
			// Drain the error body so the connection is released.
			await res.body?.cancel();
			return res.status === 404
				? { kind: "missing" }
				: { kind: "failed", reason: `the server answered HTTP ${res.status}` };
		}
		return { kind: "ok", json: await res.json() };
	} catch (error) {
		return {
			kind: "failed",
			reason:
				error instanceof SyntaxError
					? "the response was not valid JSON"
					: "the network request failed",
		};
	}
}

async function loadSnapshot(): Promise<void> {
	const fetched = await fetchJson(SNAPSHOT_URL);
	const previous = state.load;
	const parsed: Parsed<Snapshot> | null =
		fetched.kind === "ok" ? parseSnapshot(fetched.json) : null;
	if (parsed?.ok === true) {
		state.load = { kind: "ready", board: buildBoard(parsed.value), refreshError: null };
	} else {
		const reason =
			parsed?.ok === false ? parsed.reason : fetched.kind === "failed" ? fetched.reason : null;
		if (previous.kind === "ready") {
			// Keep showing what we have and say the refresh failed.
			state.load = { ...previous, refreshError: reason ?? "the snapshot is no longer published" };
			renderBanners();
			return;
		}
		state.load = reason === null ? { kind: "missing" } : { kind: "failed", reason };
	}
	if (previous.kind === "ready" && state.route.kind === "corridor") {
		// Do not rebuild a detail view under the reader; the header ages keep ticking.
		renderBanners();
		return;
	}
	render({ preserveToolbar: previous.kind === "ready" });
}

// ---------------------------------------------------------------------------
// Rendering

function render(opts: { preserveToolbar: boolean } = { preserveToolbar: false }): void {
	hideTip();
	renderBanners();
	const load = state.load;
	if (load.kind !== "ready") {
		cleanup();
		networkPill.hidden = true;
		main.replaceChildren(renderLoadState(load));
		document.title = "Corridor Weather";
		return;
	}
	const board = load.board;
	networkPill.hidden = false;
	networkPill.textContent = board.snapshot.network === "mainnet" ? "Mainnet" : "Testnet";
	if (state.route.kind === "corridor") {
		cleanup();
		renderDetail(board, state.route.id);
	} else if (opts.preserveToolbar && main.querySelector(".overview") !== null) {
		refreshOverview(board);
	} else {
		cleanup();
		renderOverview(board);
	}
}

function cleanup(): void {
	for (const fn of cleanups) fn();
	cleanups = [];
}

function renderLoadState(load: Exclude<Load, { kind: "ready" }>): HTMLElement {
	switch (load.kind) {
		case "loading":
			return h(
				"div",
				{ class: "state", role: "status" },
				h("p", undefined, "Loading current conditions…"),
			);
		case "missing":
			return h(
				"div",
				{ class: "state" },
				h("h1", undefined, "No snapshot yet"),
				h(
					"p",
					undefined,
					"The prober has not published its first snapshot. It writes one after every tick, every few minutes. This page checks again every minute.",
				),
				retryButton(),
			);
		case "failed":
			return h(
				"div",
				{ class: "state", role: "alert" },
				h("h1", undefined, "Could not load current conditions"),
				h("p", undefined, `The snapshot could not be read: ${load.reason}.`),
				retryButton(),
			);
		default: {
			const _exhaustive: never = load;
			return _exhaustive;
		}
	}
}

function retryButton(): HTMLButtonElement {
	return h(
		"button",
		{
			type: "button",
			class: "button",
			onclick: () => {
				state.load = { kind: "loading" };
				render();
				void loadSnapshot();
			},
		},
		"Try again",
	);
}

function ageEl(iso: string): HTMLTimeElement {
	return h(
		"time",
		{ datetime: iso, title: formatUtc(iso), "data-age": iso },
		formatAge(iso, Date.now()),
	);
}

function renderBanners(): void {
	const load = state.load;
	banners.replaceChildren();
	if (load.kind !== "ready") return;
	const snapshot = load.board.snapshot;
	const now = Date.now();
	if (isStale(snapshot, now)) {
		banners.append(
			h(
				"div",
				{ class: "banner banner-stale", role: "status" },
				icon("warning"),
				h(
					"p",
					undefined,
					h("strong", undefined, "Stale data. "),
					`This snapshot is ${formatDuration(snapshotAgeMs(snapshot, now))} old, longer than three tick intervals (${formatDuration(
						3 * snapshot.tickIntervalMinutes * 60_000,
					)}). The prober may have stopped, so the conditions below may be out of date.`,
				),
			),
		);
	}
	if (load.refreshError !== null) {
		banners.append(
			h(
				"div",
				{ class: "banner banner-error", role: "status" },
				icon("warning"),
				h(
					"p",
					undefined,
					`Could not refresh: ${load.refreshError}. Showing the snapshot from `,
					ageEl(snapshot.generatedAt),
					".",
				),
			),
		);
	}
}

// ---------------------------------------------------------------------------
// Overview

function renderOverview(board: Board): void {
	document.title = "Corridor Weather";
	const filterInput = h("input", {
		type: "search",
		id: "filter",
		class: "input",
		placeholder: "e.g. base usdc",
		autocomplete: "off",
		spellcheck: "false",
		value: state.filter.text,
		"aria-describedby": "filter-hint",
		oninput: (e: Event) => {
			if (e.target instanceof HTMLInputElement) {
				state.filter = { ...state.filter, text: e.target.value };
				refreshCorridors(board);
			}
		},
	});
	const viewButtons = (["matrix", "list"] as const).map((view) =>
		h(
			"button",
			{
				type: "button",
				class: "seg",
				"data-view": view,
				"aria-pressed": String(state.view === view),
				onclick: () => {
					state.view = view;
					for (const b of main.querySelectorAll<HTMLButtonElement>("[data-view]")) {
						b.setAttribute("aria-pressed", String(b.dataset.view === view));
					}
					refreshCorridors(board);
				},
			},
			view === "matrix" ? "Matrix" : "List",
		),
	);
	main.replaceChildren(
		h(
			"div",
			{ class: "overview" },
			h("section", { class: "report", "aria-labelledby": "report-h" }, ...reportContent(board)),
			h(
				"section",
				{ class: "corridors", "aria-labelledby": "corridors-h" },
				h(
					"div",
					{ class: "toolbar" },
					h("h2", { id: "corridors-h" }, "Corridors"),
					h(
						"div",
						{ class: "field" },
						h("label", { for: "filter" }, "Filter by chain or symbol"),
						filterInput,
						h(
							"span",
							{ id: "filter-hint", class: "visually-hidden" },
							"Every word must match the source or destination.",
						),
					),
					h("div", { class: "segmented", role: "group", "aria-label": "Layout" }, ...viewButtons),
					h("p", { class: "count", id: "match-count", "aria-live": "polite" }),
				),
				legend(),
				h("div", { id: "corridor-body" }),
			),
		),
	);
	refreshCorridors(board);
	window.scrollTo({ top: state.overviewScroll });
}

/** Re-renders everything in the overview except the toolbar, so the filter keeps focus. */
function refreshOverview(board: Board): void {
	const report = main.querySelector(".report");
	if (report !== null) report.replaceChildren(...reportContent(board));
	refreshCorridors(board);
}

function reportContent(board: Board): HTMLElement[] {
	const snap = board.snapshot;
	const counts = conditionCounts(snap.corridors);
	const network = snap.network === "mainnet" ? "Mainnet" : "Testnet";
	const tick = snap.lastTick;
	const tiles = CONDITIONS.map((c) => {
		const pressed = state.filter.conditions.has(c);
		return h(
			"button",
			{
				type: "button",
				class: `tile cond-${c}`,
				"aria-pressed": String(pressed),
				"data-condition": c,
				onclick: () => toggleCondition(board, c),
			},
			h(
				"span",
				{ class: "tile-top" },
				icon(c),
				h("span", { class: "tile-label" }, CONDITION_TEXT[c].label),
			),
			h("span", { class: "tile-value" }, counts[c].toLocaleString("en-US")),
			h("span", { class: "tile-rule" }, CONDITION_TEXT[c].rule),
		);
	});
	return [
		h(
			"div",
			{ class: "report-main" },
			h("h1", { id: "report-h" }, `${network} corridor conditions`),
			h(
				"p",
				{ class: "asof" },
				"Snapshot published ",
				ageEl(snap.generatedAt),
				` (${formatUtc(snap.generatedAt)}).`,
			),
			h(
				"div",
				{
					class: "tiles",
					role: "group",
					"aria-label": "Corridors by condition. Select one or more to filter the corridors below.",
				},
				...tiles,
			),
			h(
				"dl",
				{ class: "facts" },
				fact(
					"Last tick",
					tick === null
						? "No tick has finished yet."
						: h(
								"span",
								undefined,
								"Finished ",
								ageEl(tick.finishedAt),
								`. ${tick.completed} of ${formatCount(tick.planned, "planned probe")} completed`,
								tick.gatewayErrors > 0
									? `, ${formatCount(tick.gatewayErrors, "gateway error")}`
									: ", no gateway errors",
								tick.aborted === null ? "." : `. Stopped early: ${tick.aborted}.`,
							),
				),
				fact(
					"Cadence",
					`${capitalize(
						formatCadence({ ...snap.cadence, tickIntervalMinutes: snap.tickIntervalMinutes }),
					)}. Each probe asks for a quote and records the answers; it never pays.`,
				),
				fact(
					"Coverage",
					`${formatCount(snap.corridors.length, "corridor")} between ${formatCount(snap.assets.length, "asset")} on ${formatCount(
						board.chains.length,
						"chain",
					)}, each at ${formatCount(TIERS.length, "amount tier")}.`,
				),
			),
		),
		alertsPanel(board, snap.alerts),
	];
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function fact(term: string, detail: string | HTMLElement): HTMLElement {
	return h("div", undefined, h("dt", undefined, term), h("dd", undefined, detail));
}

function toggleCondition(board: Board, c: Condition): void {
	const next = new Set(state.filter.conditions);
	if (next.has(c)) next.delete(c);
	else next.add(c);
	state.filter = { ...state.filter, conditions: next };
	for (const b of main.querySelectorAll<HTMLButtonElement>("[data-condition]")) {
		b.setAttribute(
			"aria-pressed",
			String(b.dataset.condition !== undefined && next.has(conditionOf(b.dataset.condition))),
		);
	}
	refreshCorridors(board);
}

function conditionOf(value: string): Condition {
	return CONDITIONS.find((c) => c === value) ?? "unknown";
}

function alertsPanel(board: Board, alerts: readonly Alert[]): HTMLElement {
	const sorted = [...alerts].sort((a, b) =>
		a.severity === b.severity
			? Date.parse(b.since) - Date.parse(a.since)
			: a.severity === "critical"
				? -1
				: 1,
	);
	return h(
		"section",
		{ class: "alerts", "aria-labelledby": "alerts-h" },
		h(
			"h2",
			{ id: "alerts-h" },
			"Active alerts",
			h("span", { class: "badge" }, String(alerts.length)),
		),
		sorted.length === 0
			? h("p", { class: "muted" }, "No active alerts.")
			: h("ul", { class: "alert-list" }, ...sorted.map((a) => alertItem(board, a))),
		h("p", { class: "fine" }, "Alerts describe what the prober saw. They page nobody."),
	);
}

const ALERT_TITLE: Readonly<Record<Alert["kind"], string>> = {
	prober_stale: "Prober stale",
	gateway_errors: "Gateway errors",
	quotes_lost: "Quotes lost",
	slow_quotes: "Slow quotes",
};

function alertItem(board: Board, a: Alert): HTMLElement {
	const corridor = a.corridorId === null ? undefined : board.corridorsById.get(a.corridorId);
	return h(
		"li",
		{ class: `alert alert-${a.severity}` },
		icon(a.severity),
		h(
			"div",
			undefined,
			h(
				"p",
				{ class: "alert-title" },
				h(
					"span",
					{ class: "visually-hidden" },
					`${a.severity === "critical" ? "Critical" : "Warning"}: `,
				),
				ALERT_TITLE[a.kind],
				corridor === undefined
					? null
					: h(
							"span",
							undefined,
							" · ",
							h("a", { href: corridorHref(corridor.id) }, corridorName(board, corridor)),
						),
			),
			h("p", undefined, a.message),
			h("p", { class: "fine" }, "Since ", ageEl(a.since)),
		),
	);
}

function corridorName(board: Board, c: CorridorConditions): string {
	return `${shortAsset(board.assetsById.get(c.source), c.source)} → ${shortAsset(board.assetsById.get(c.destination), c.destination)}`;
}

function shortAsset(asset: SnapshotAsset | undefined, fallback: string): string {
	return asset === undefined ? fallback : `${asset.symbol} (${asset.chainLabel})`;
}

function legend(): HTMLElement {
	return h(
		"div",
		{ class: "legend", "aria-label": "Legend" },
		h(
			"ul",
			{ class: "legend-conditions" },
			...CONDITIONS.map((c) =>
				h(
					"li",
					undefined,
					h("span", { class: `swatch cond-${c}` }, icon(c)),
					h("strong", undefined, CONDITION_TEXT[c].label),
					` ${CONDITION_TEXT[c].rule}`,
				),
			),
		),
		h(
			"p",
			{ class: "legend-cells" },
			h(
				"span",
				{ class: "sample" },
				h("span", { class: "v" }, "12"),
				h("span", { class: "o" }, "3 op"),
			),
			"Best spread in basis points over face value, lowest across the latest tier readings, and the operators that quoted. ",
			h("strong", undefined, "n/a"),
			" means the tokens do not share a peg, so no spread is computed. In the matrix, rows are the source and columns the destination.",
		),
	);
}

// ---------------------------------------------------------------------------
// Corridors: matrix and list

function refreshCorridors(board: Board): void {
	hideTip();
	const body = main.querySelector("#corridor-body");
	const count = main.querySelector("#match-count");
	if (body === null) return;
	const visible = board.snapshot.corridors.filter((c) =>
		matchesFilter(c, board.assetsById, state.filter),
	);
	if (count !== null) {
		count.textContent =
			visible.length === board.snapshot.corridors.length
				? `Showing all ${formatCount(visible.length, "corridor")}`
				: `Showing ${visible.length.toLocaleString("en-US")} of ${formatCount(board.snapshot.corridors.length, "corridor")}`;
	}
	if (board.snapshot.corridors.length === 0) {
		body.replaceChildren(
			h(
				"p",
				{ class: "empty" },
				"The snapshot lists no corridors yet. Discovery runs at the start of every tick.",
			),
		);
		return;
	}
	if (visible.length === 0) {
		body.replaceChildren(
			h(
				"div",
				{ class: "empty" },
				h("p", undefined, "No corridor matches this filter."),
				h(
					"button",
					{
						type: "button",
						class: "button",
						onclick: () => {
							state.filter = { text: "", conditions: new Set() };
							render();
						},
					},
					"Clear the filter",
				),
			),
		);
		return;
	}
	body.replaceChildren(
		state.view === "matrix"
			? matrix(board, new Set(visible.map((c) => c.id)))
			: list(board, visible),
	);
}

function cellLabel(board: Board, c: CorridorConditions): string {
	const sum = summarizeCorridor(c);
	const parts = [`${corridorFullName(board, c)}: ${CONDITION_TEXT[c.condition].label}`];
	if (c.lastProbedAt === null) parts.push("never probed");
	else {
		if (sum.quotedTiers > 0)
			parts.push(
				sum.spreadUndefined
					? "spread not computed across pegs"
					: `best spread ${formatBps(sum.bestSpreadBps)}`,
			);
		parts.push(`${formatCount(sum.operatorCount, "operator")} quoting`);
		parts.push(`probed ${formatAge(c.lastProbedAt, Date.now())}`);
	}
	return parts.join(", ");
}

function corridorFullName(board: Board, c: CorridorConditions): string {
	return `${assetName(board.assetsById.get(c.source), c.source)} to ${assetName(board.assetsById.get(c.destination), c.destination)}`;
}

function cellTip(board: Board, c: CorridorConditions): (HTMLElement | string)[] {
	const dest = board.assetsById.get(c.destination);
	const head = h("div", { class: "tip-head" }, corridorName(board, c));
	const cond = h(
		"div",
		{ class: "tip-cond" },
		icon(c.condition),
		h("strong", undefined, CONDITION_TEXT[c.condition].label),
		` · ${CONDITION_TEXT[c.condition].rule}`,
	);
	if (c.lastProbedAt === null) return [head, cond];
	const rows = tiersInOrder(c).map((t) =>
		tipRow(
			t.outcome === "quoted"
				? `${formatBps(t.bestSpreadBps)}, ${formatCount(t.operatorCount, "operator")}`
				: OUTCOME_TEXT[t.outcome].label,
			`${capitalize(t.tier)} · ${dest === undefined ? t.fulfillmentAmount : `${formatAtomicAmount(t.fulfillmentAmount, dest.decimals)} ${dest.symbol}`}`,
		),
	);
	return [
		head,
		cond,
		...rows,
		h("div", { class: "tip-foot" }, `Last probed ${formatAge(c.lastProbedAt, Date.now())}`),
	];
}

function attachCellTip(el: HTMLElement, content: () => (HTMLElement | string)[]): void {
	const show = (): void => showTip(content(), el.getBoundingClientRect());
	el.addEventListener("pointerenter", show);
	el.addEventListener("pointerleave", hideTip);
	el.addEventListener("focus", show);
	el.addEventListener("blur", hideTip);
}

function matrix(board: Board, visibleIds: ReadonlySet<string>): HTMLElement {
	const corridors = board.snapshot.corridors;
	const matching = corridors.filter((c) => visibleIds.has(c.id));
	const rowIds = new Set(matching.map((c) => c.source));
	const colIds = new Set(matching.map((c) => c.destination));
	const filtering = matching.length !== corridors.length;
	const rowGroups = board.chains
		.map((g) => ({ ...g, assets: g.assets.filter((a) => rowIds.has(a.id)) }))
		.filter((g) => g.assets.length > 0);
	const colGroups = board.chains
		.map((g) => ({ ...g, assets: g.assets.filter((a) => colIds.has(a.id)) }))
		.filter((g) => g.assets.length > 0);
	const cols = colGroups.flatMap((g) =>
		g.assets.map((a, i) => ({ asset: a, groupStart: i === 0 })),
	);

	const head = h(
		"thead",
		undefined,
		h(
			"tr",
			undefined,
			h("td", { class: "corner", colspan: 2, rowspan: 2 }, h("span", undefined, "From ↓ To →")),
			...colGroups.map((g) =>
				h(
					"th",
					{
						scope: "colgroup",
						colspan: g.assets.length,
						class: "chain-col group-start",
						title: g.chainLabel,
					},
					g.chainLabel,
				),
			),
		),
		h(
			"tr",
			undefined,
			...cols.map(({ asset, groupStart }) =>
				h(
					"th",
					{
						scope: "col",
						class: groupStart ? "sym-col group-start" : "sym-col",
						title: `${asset.symbol} on ${asset.chainLabel}`,
					},
					h("span", undefined, asset.symbol),
				),
			),
		),
	);

	// Pick the roving tab stop: keep the previous one when it is still shown.
	const firstKey = (() => {
		for (const g of rowGroups) {
			for (const a of g.assets) {
				for (const col of cols) {
					const c = board.corridorAt(a.id, col.asset.id);
					if (c !== undefined) return c.id;
				}
			}
		}
		return null;
	})();
	const activeShown =
		state.activeCell !== null && rowIds.size > 0 && matching.some((c) => c.id === state.activeCell);
	const active = activeShown ? state.activeCell : firstKey;

	let r = 0;
	const body = h("tbody");
	for (const g of rowGroups) {
		g.assets.forEach((asset, i) => {
			const tr = h("tr", { class: i === 0 ? "group-start" : undefined });
			if (i === 0)
				tr.append(
					h(
						"th",
						{ scope: "rowgroup", rowspan: g.assets.length, class: "chain-row" },
						h("span", undefined, g.chainLabel),
					),
				);
			tr.append(
				h(
					"th",
					{ scope: "row", class: "sym-row", title: `${asset.symbol} on ${asset.chainLabel}` },
					asset.symbol,
				),
			);
			cols.forEach(({ asset: dest, groupStart }, ci) => {
				const c = board.corridorAt(asset.id, dest.id);
				const td = h("td", { class: groupStart ? "cell group-start" : "cell" });
				if (c === undefined) {
					td.classList.add("same");
					td.append(
						h("span", {
							class: "nocell",
							"data-r": r,
							"data-c": ci,
							tabindex: -1,
							"aria-label": asset.id === dest.id ? "Same asset, no corridor" : "No corridor",
						}),
					);
				} else {
					const sum = summarizeCorridor(c);
					td.classList.add(`cond-${c.condition}`);
					if (filtering && !visibleIds.has(c.id)) td.classList.add("dim");
					const link = h(
						"a",
						{
							href: corridorHref(c.id),
							"data-r": r,
							"data-c": ci,
							"data-id": c.id,
							tabindex: c.id === active ? 0 : -1,
							"aria-label": cellLabel(board, c),
						},
						h(
							"span",
							{ class: "v" },
							icon(c.condition),
							c.lastProbedAt === null || sum.quotedTiers === 0
								? null
								: sum.bestSpreadBps === null
									? "n/a"
									: formatBpsShort(sum.bestSpreadBps),
						),
						sum.quotedTiers === 0 ? null : h("span", { class: "o" }, `${sum.operatorCount} op`),
					);
					link.addEventListener("click", () => {
						state.activeCell = c.id;
					});
					attachCellTip(link, () => cellTip(board, c));
					td.append(link);
				}
				tr.append(td);
			});
			body.append(tr);
			r += 1;
		});
	}
	const table = h(
		"table",
		{
			class: "matrix",
			role: "grid",
			"aria-label":
				"Corridor conditions. Rows are source assets, columns are destination assets. Use the arrow keys to move between cells.",
		},
		head,
		body,
	);
	table.addEventListener("keydown", (e) => moveInGrid(table, e));
	return h("div", { class: "matrix-scroll" }, table);
}

function moveInGrid(table: HTMLTableElement, e: KeyboardEvent): void {
	const target = e.target;
	if (
		!(target instanceof HTMLElement) ||
		target.dataset.r === undefined ||
		target.dataset.c === undefined
	)
		return;
	let r = Number(target.dataset.r);
	let c = Number(target.dataset.c);
	const lastRow = table.tBodies[0]?.rows.length ?? 1;
	const lastCol = table.tHead?.rows[1]?.cells.length ?? 1;
	switch (e.key) {
		case "ArrowRight":
			c += 1;
			break;
		case "ArrowLeft":
			c -= 1;
			break;
		case "ArrowDown":
			r += 1;
			break;
		case "ArrowUp":
			r -= 1;
			break;
		case "Home":
			c = 0;
			if (e.ctrlKey) r = 0;
			break;
		case "End":
			c = lastCol - 1;
			if (e.ctrlKey) r = lastRow - 1;
			break;
		default:
			return;
	}
	e.preventDefault();
	r = Math.max(0, Math.min(lastRow - 1, r));
	c = Math.max(0, Math.min(lastCol - 1, c));
	const next = table.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`);
	if (next === null) return;
	for (const el of table.querySelectorAll<HTMLElement>('[tabindex="0"]')) el.tabIndex = -1;
	next.tabIndex = 0;
	next.focus();
	if (next.dataset.id !== undefined) state.activeCell = next.dataset.id;
}

function list(board: Board, visible: readonly CorridorConditions[]): HTMLElement {
	const order = new Map(board.orderedAssets.map((a, i) => [a.id, i]));
	const bySource = new Map<string, CorridorConditions[]>();
	for (const c of visible) {
		const group = bySource.get(c.source);
		if (group === undefined) bySource.set(c.source, [c]);
		else group.push(c);
	}
	const filtering = state.filter.text.trim() !== "" || state.filter.conditions.size > 0;
	const openAll = filtering && visible.length <= 80;
	const groups = board.orderedAssets.flatMap((asset) => {
		const rows = bySource.get(asset.id);
		if (rows === undefined) return [];
		rows.sort((a, b) => (order.get(a.destination) ?? 0) - (order.get(b.destination) ?? 0));
		const counts = conditionCounts(rows);
		const details = h(
			"details",
			{ class: "group", open: openAll || state.openGroups.has(asset.id) },
			h(
				"summary",
				undefined,
				h(
					"span",
					{ class: "group-name" },
					h("span", { class: "fine" }, "From "),
					assetBlock(asset, asset.id),
				),
				h(
					"span",
					{ class: "group-counts" },
					...CONDITIONS.filter((c) => counts[c] > 0).map((c) =>
						h(
							"span",
							{ class: `mini cond-${c}` },
							icon(c),
							String(counts[c]),
							h("span", { class: "visually-hidden" }, ` ${CONDITION_TEXT[c].label.toLowerCase()},`),
						),
					),
				),
			),
			listTable(board, asset, rows),
		);
		details.addEventListener("toggle", () => {
			if (details.open) state.openGroups.add(asset.id);
			else state.openGroups.delete(asset.id);
		});
		return [details];
	});
	return h("div", { class: "groups" }, ...groups);
}

function listTable(
	board: Board,
	source: SnapshotAsset,
	rows: readonly CorridorConditions[],
): HTMLElement {
	return h(
		"table",
		{ class: "list" },
		h(
			"caption",
			{ class: "visually-hidden" },
			`Corridors from ${source.symbol} on ${source.chainLabel}`,
		),
		h(
			"thead",
			undefined,
			h(
				"tr",
				undefined,
				h("th", { scope: "col" }, "To"),
				h("th", { scope: "col" }, "Condition"),
				h("th", { scope: "col", class: "num" }, "Best spread"),
				h("th", { scope: "col", class: "num" }, "Operators"),
				h("th", { scope: "col" }, "Last probed"),
			),
		),
		h(
			"tbody",
			undefined,
			...rows.map((c) => {
				const sum = summarizeCorridor(c);
				const quoted = sum.quotedTiers > 0;
				return h(
					"tr",
					undefined,
					h(
						"td",
						{ class: "l-name" },
						h(
							"a",
							{ href: corridorHref(c.id), "aria-label": corridorFullName(board, c) },
							assetBlock(board.assetsById.get(c.destination), c.destination),
						),
					),
					h(
						"td",
						{ class: "l-cond" },
						h(
							"span",
							{ class: `chip cond-${c.condition}` },
							icon(c.condition),
							CONDITION_TEXT[c.condition].label,
						),
					),
					h(
						"td",
						{ class: quoted ? "num l-spread" : "num l-spread na" },
						quoted ? formatBps(sum.bestSpreadBps) : "–",
					),
					h(
						"td",
						{ class: quoted ? "num l-ops" : "num l-ops na" },
						quoted ? formatCount(sum.operatorCount, "operator") : "–",
					),
					h(
						"td",
						{ class: "l-age" },
						c.lastProbedAt === null
							? "Never probed"
							: [h("span", { class: "narrow-only" }, "Probed "), ageEl(c.lastProbedAt)],
					),
				);
			}),
		),
	);
}

function assetBlock(asset: SnapshotAsset | undefined, fallback: string): HTMLElement {
	return h(
		"span",
		{ class: "asset" },
		h("span", { class: "asset-sym" }, asset?.symbol ?? fallback),
		asset === undefined ? null : h("span", { class: "asset-chain" }, asset.chainLabel),
	);
}

// ---------------------------------------------------------------------------
// Corridor detail

let historyRequest = 0;

function renderDetail(board: Board, id: string): void {
	const c = board.corridorsById.get(id);
	const back = h("a", { class: "back", href: "#/" }, "← All corridors");
	if (c === undefined) {
		document.title = "Unknown corridor · Corridor Weather";
		main.replaceChildren(
			h(
				"div",
				{ class: "detail" },
				back,
				h(
					"div",
					{ class: "state" },
					h("h1", { tabindex: -1 }, "Corridor not found"),
					h(
						"p",
						undefined,
						"This corridor is not in the current snapshot. The gateway may no longer list one of its assets.",
					),
					h("p", { class: "mono" }, id),
				),
			),
		);
		return;
	}
	const src = board.assetsById.get(c.source);
	const dst = board.assetsById.get(c.destination);
	document.title = `${src?.symbol ?? "?"} → ${dst?.symbol ?? "?"} · Corridor Weather`;
	const title = h(
		"h1",
		{ tabindex: -1, class: "detail-title" },
		assetBlock(src, c.source),
		h("span", { class: "arrow", "aria-label": "to" }, "→"),
		assetBlock(dst, c.destination),
	);
	const alerts = board.snapshot.alerts.filter((a) => a.corridorId === c.id);
	const history = h("div", { class: "history" });
	main.replaceChildren(
		h(
			"article",
			{ class: "detail" },
			back,
			h(
				"header",
				{ class: "detail-head" },
				title,
				h(
					"p",
					{ class: "detail-meta" },
					h(
						"span",
						{ class: `chip cond-${c.condition}` },
						icon(c.condition),
						CONDITION_TEXT[c.condition].label,
					),
					h("span", undefined, capitalize(CONDITION_TEXT[c.condition].rule), "."),
					c.lastProbedAt === null
						? null
						: h("span", undefined, "Last probed ", ageEl(c.lastProbedAt), "."),
				),
				h("p", { class: "mono fine" }, c.id),
			),
			alerts.length === 0
				? null
				: h("ul", { class: "alert-list" }, ...alerts.map((a) => alertItem(board, a))),
			c.lastProbedAt === null ? neverProbed(board) : latestTable(c, src, dst),
			c.lastProbedAt === null ? null : history,
		),
	);
	title.focus({ preventScroll: true });
	window.scrollTo({ top: 0 });
	if (c.lastProbedAt !== null) void loadHistory(board, c, history);
}

function neverProbed(board: Board): HTMLElement {
	const { cadence, tickIntervalMinutes } = board.snapshot;
	return h(
		"section",
		{ class: "card state" },
		h("h2", undefined, "Not probed yet"),
		h(
			"p",
			undefined,
			`The prober has not reached this corridor. It runs ${formatCadence({ ...cadence, tickIntervalMinutes })}, so every corridor gets a reading within about ${formatDuration(
				cadence.sweepHours * 3_600_000,
			)} of being discovered.`,
		),
	);
}

function amountText(atomic: string, asset: SnapshotAsset | undefined): string {
	return asset === undefined
		? `${atomic} (atomic units)`
		: `${formatAtomicAmount(atomic, asset.decimals)} ${asset.symbol}`;
}

function latestTable(
	c: CorridorConditions,
	src: SnapshotAsset | undefined,
	dst: SnapshotAsset | undefined,
): HTMLElement {
	const tiers = tiersInOrder(c);
	return h(
		"section",
		{ class: "card", "aria-labelledby": "latest-h" },
		h("h2", { id: "latest-h" }, "Latest reading per amount tier"),
		h(
			"p",
			{ class: "fine" },
			"Each tier asks for a quote that delivers the amount shown at the destination. “You would send” is the lowest quoted source amount. Indicative only, not an offer.",
		),
		h(
			"div",
			{ class: "table-scroll" },
			h(
				"table",
				{ class: "data tiers" },
				h(
					"thead",
					undefined,
					h(
						"tr",
						undefined,
						h("th", { scope: "col" }, "Tier"),
						h("th", { scope: "col" }, "Outcome"),
						h("th", { scope: "col", class: "num" }, "Best spread"),
						h("th", { scope: "col", class: "num" }, "Worst spread"),
						h("th", { scope: "col", class: "num" }, "You would send"),
						h("th", { scope: "col", class: "num" }, "Operators"),
						h("th", { scope: "col", class: "num" }, "Quotes"),
						h("th", { scope: "col", class: "num" }, "First quote"),
						h("th", { scope: "col", class: "num" }, "Price hold"),
						h("th", { scope: "col" }, "Declines"),
						h("th", { scope: "col" }, "Probed"),
					),
				),
				h(
					"tbody",
					undefined,
					...TIERS.map((tier) => {
						const t = tiers.find((x) => x.tier === tier);
						if (t === undefined) {
							return h(
								"tr",
								undefined,
								h("th", { scope: "row" }, capitalize(tier)),
								h("td", { colspan: 10, class: "muted" }, "Not probed yet"),
							);
						}
						return h(
							"tr",
							undefined,
							h(
								"th",
								{ scope: "row" },
								h("span", { class: "tier-name" }, capitalize(tier)),
								h("span", { class: "fine" }, amountText(t.fulfillmentAmount, dst)),
							),
							h("td", { "data-label": "Outcome" }, outcomeChip(t.outcome)),
							h(
								"td",
								{ class: "num", "data-label": "Best spread" },
								t.outcome === "quoted" ? formatBps(t.bestSpreadBps) : "–",
							),
							h(
								"td",
								{ class: "num", "data-label": "Worst spread" },
								t.outcome === "quoted" ? formatBps(t.worstSpreadBps) : "–",
							),
							h(
								"td",
								{ class: "num", "data-label": "You would send" },
								t.bestSourceAmount === null ? "–" : amountText(t.bestSourceAmount, src),
							),
							h("td", { class: "num", "data-label": "Operators" }, String(t.operatorCount)),
							h("td", { class: "num", "data-label": "Quotes" }, String(t.quoteCount)),
							h(
								"td",
								{ class: "num", "data-label": "First quote" },
								t.firstQuoteMs === null ? "–" : formatMs(t.firstQuoteMs),
							),
							h(
								"td",
								{ class: "num", "data-label": "Price hold" },
								t.minPriceHoldMs === null ? "–" : formatMs(t.minPriceHoldMs),
							),
							h("td", { "data-label": "Declines" }, declineList(t.declines)),
							h("td", { "data-label": "Probed" }, ageEl(t.probedAt)),
						);
					}),
				),
			),
		),
	);
}

function outcomeChip(outcome: CorridorConditions["tiers"][number]["outcome"]): HTMLElement {
	return h(
		"span",
		{ class: `outcome o-${outcome}`, title: OUTCOME_TEXT[outcome].meaning },
		OUTCOME_TEXT[outcome].label,
	);
}

function declineList(
	declines: CorridorConditions["tiers"][number]["declines"],
): HTMLElement | string {
	if (declines.length === 0) return "–";
	return h(
		"ul",
		{ class: "plain" },
		...declines.map((d) =>
			h(
				"li",
				undefined,
				`${humanizeCode(d.reason)} ×${d.count}`,
				h("span", { class: "fine" }, ` ${retryText(d.retryClassification)}`),
			),
		),
	);
}

function retryText(classification: string | null): string {
	if (classification === RETRY_AFTER_DELAY) return "may clear on retry";
	if (classification === null) return "unclassified";
	return humanizeCode(classification).toLowerCase();
}

async function loadHistory(board: Board, c: CorridorConditions, slot: HTMLElement): Promise<void> {
	const request = ++historyRequest;
	slot.replaceChildren(
		h("p", { class: "state", role: "status" }, `Loading ${HISTORY_DAYS} days of history…`),
	);
	const fetched = await fetchJson(historyUrl(c.id, HISTORY_DAYS));
	if (request !== historyRequest || !slot.isConnected) return;
	if (fetched.kind === "missing") {
		slot.replaceChildren(
			h("p", { class: "card state" }, "No history is published for this corridor yet."),
		);
		return;
	}
	if (fetched.kind === "failed") {
		slot.replaceChildren(historyError(fetched.reason, board, c, slot));
		return;
	}
	const parsed = parseHistory(fetched.json);
	if (!parsed.ok) {
		slot.replaceChildren(historyError(parsed.reason, board, c, slot));
		return;
	}
	slot.replaceChildren(...historySections(board, c, parsed.value));
}

function historyError(
	reason: string,
	board: Board,
	c: CorridorConditions,
	slot: HTMLElement,
): HTMLElement {
	return h(
		"div",
		{ class: "card state", role: "alert" },
		h("p", undefined, `Could not load the history: ${reason}.`),
		h(
			"button",
			{ type: "button", class: "button", onclick: () => void loadHistory(board, c, slot) },
			"Try again",
		),
	);
}

const TIER_CLASS = { small: "s-small", typical: "s-typical", large: "s-large" } as const;

function chartSlot(render: (width: number) => SVGSVGElement): HTMLElement {
	const slot = h("div", { class: "chart-slot" });
	let lastWidth = 0;
	const observer = new ResizeObserver(() => {
		const width = Math.floor(slot.clientWidth);
		if (width > 0 && width !== lastWidth) {
			lastWidth = width;
			hideTip();
			slot.replaceChildren(render(width));
		}
	});
	observer.observe(slot);
	cleanups.push(() => observer.disconnect());
	return slot;
}

function lineLegend(): HTMLElement {
	return h(
		"ul",
		{ class: "chart-legend" },
		...TIERS.map((t) =>
			h("li", undefined, h("span", { class: `key-line ${TIER_CLASS[t]}` }), capitalize(t)),
		),
	);
}

function historySections(
	board: Board,
	c: CorridorConditions,
	history: CorridorHistory,
): HTMLElement[] {
	const points = history.points;
	const end = Date.parse(history.generatedAt);
	const start = end - history.days * 86_400_000;
	const dst = board.assetsById.get(c.destination);
	const days = formatCount(history.days, "day");
	if (points.length === 0) {
		return [
			h(
				"section",
				{ class: "card state" },
				h("h2", undefined, `History, last ${days}`),
				h("p", undefined, `No probes of this corridor in the last ${days}.`),
			),
		];
	}
	const prices = priceBySize(c, points);
	const spreads = spreadSeries(points);
	const anySpread = spreads.some((se) => se.points.some((p) => p.v !== null));
	const operators = operatorSeries(points);
	const maxOperators = Math.max(1, ...operators.flatMap((se) => se.points.map((p) => p.v ?? 0)));
	const buckets = declineBuckets({ points, start, end, bucketMs: (end - start) / 28 });
	const reasons = declineReasons(points);
	const tallies = outcomeTallies(points);
	const tierLabel = (tier: (typeof TIERS)[number]): string => {
		const price = prices.find((p) => p.tier === tier);
		return price === undefined || price.fulfillmentAmount === null
			? capitalize(tier)
			: `${capitalize(tier)} (${amountText(price.fulfillmentAmount, dst)})`;
	};
	const toSeries = (series: typeof spreads): LineSeries[] =>
		series.map((se) => ({
			label: capitalize(se.tier),
			cls: TIER_CLASS[se.tier],
			points: se.points,
		}));
	const anyDecline = buckets.some((b) => b.retryable + b.other > 0);

	return [
		h(
			"section",
			{ class: "card", "aria-labelledby": "size-h" },
			h("h2", { id: "size-h" }, "Price by payment size"),
			h(
				"p",
				{ class: "fine" },
				`Best spread per amount tier. The bar is the latest reading; the thin line under it spans the lowest to highest best spread in the last ${days}.`,
			),
			anySpread || prices.some((p) => p.latestBps !== null)
				? chartSlot((width) =>
						sizeChart({
							label: `Best spread by amount tier. ${prices.map((p) => `${tierLabel(p.tier)}: ${p.latestBps === null ? "no quote" : formatBps(p.latestBps)}`).join("; ")}.`,
							width,
							format: (v) => formatBps(v),
							rows: prices.map((p) => ({
								label: capitalize(p.tier),
								sublabel: p.fulfillmentAmount === null ? "" : amountText(p.fulfillmentAmount, dst),
								latest: p.latestBps,
								range: p.range,
								emptyText:
									c.tiers.find((t) => t.tier === p.tier)?.outcome === "quoted"
										? "quoted, no spread across pegs"
										: "no quote in the latest reading",
							})),
						}),
					)
				: h(
						"p",
						{ class: "muted" },
						"No spread to show. Either no tier was quoted, or the tokens do not share a peg.",
					),
		),
		h(
			"section",
			{ class: "card", "aria-labelledby": "spread-h" },
			h("h2", { id: "spread-h" }, `Best spread, last ${days}`),
			h(
				"p",
				{ class: "fine" },
				"Basis points over face value, per amount tier. A gap means that probe got no quote.",
			),
			anySpread
				? [
						lineLegend(),
						chartSlot((width) =>
							lineChart({
								label: `Best spread over the last ${days}, per amount tier. The data table below lists every probe.`,
								series: toSeries(spreads),
								start,
								end,
								width,
								height: width < 500 ? 200 : 240,
								step: false,
								integer: false,
								yFormat: (v) => formatBpsShort(v),
								valueText: (p) =>
									p.v === null ? OUTCOME_TEXT[p.point.outcome].label.toLowerCase() : formatBps(p.v),
							}),
						),
					]
				: h(
						"p",
						{ class: "muted" },
						"No spread in this window. Either no tier was quoted, or the tokens do not share a peg.",
					),
		),
		h(
			"section",
			{ class: "card", "aria-labelledby": "ops-h" },
			h("h2", { id: "ops-h" }, `Operators quoting, last ${days}`),
			h(
				"p",
				{ class: "fine" },
				"How many operators returned a quote, per amount tier. A drop to zero means quotes were lost. This page counts operators; it does not name or rank them.",
			),
			...operators.map((se, i) =>
				h(
					"div",
					{ class: "multiple" },
					h("h3", undefined, tierLabel(se.tier)),
					chartSlot((width) =>
						lineChart({
							label: `Operators quoting the ${se.tier} tier over the last ${days}. The data table below lists every probe.`,
							series: toSeries([se]),
							start,
							end,
							width,
							height: i === operators.length - 1 ? 92 : 72,
							step: true,
							area: true,
							integer: true,
							yMax: maxOperators,
							xLabels: i === operators.length - 1,
							directLabels: false,
							yFormat: (v) => String(v),
							valueText: (p) =>
								p.point.outcome === "quoted"
									? formatCount(p.v ?? 0, "operator")
									: `0, ${OUTCOME_TEXT[p.point.outcome].label.toLowerCase()}`,
						}),
					),
				),
			),
		),
		h(
			"section",
			{ class: "card", "aria-labelledby": "declines-h" },
			h("h2", { id: "declines-h" }, `Declines, last ${days}`),
			h(
				"p",
				{ class: "fine" },
				"Declines summed over each six-hour window, all tiers. “May clear on retry” is the gateway's RETRY_AFTER_DELAY classification; everything else, including declines with no classification, will not change by waiting.",
			),
			anyDecline
				? [
						h(
							"ul",
							{ class: "chart-legend" },
							h(
								"li",
								undefined,
								h("span", { class: "key-rect s-other" }),
								"Will not clear on retry",
							),
							h("li", undefined, h("span", { class: "key-rect s-retry" }), "May clear on retry"),
						),
						chartSlot((width) =>
							declineChart({
								label: `Declines over the last ${days}, split by whether a retry could change them. The reasons table follows.`,
								buckets,
								start,
								end,
								width,
								height: width < 500 ? 160 : 180,
								retryLabel: "may clear on retry",
								otherLabel: "will not clear on retry",
							}),
						),
						reasonsTable(reasons),
					]
				: h("p", { class: "muted" }, `No declines in the last ${days}.`),
		),
		h(
			"section",
			{ class: "card", "aria-labelledby": "outcomes-h" },
			h("h2", { id: "outcomes-h" }, `Outcomes, last ${days}`),
			h(
				"div",
				{ class: "table-scroll" },
				h(
					"table",
					{ class: "data outcomes" },
					h(
						"thead",
						undefined,
						h(
							"tr",
							undefined,
							h("th", { scope: "col" }, "Tier"),
							...OUTCOMES.map((o) =>
								h(
									"th",
									{ scope: "col", class: "num", title: OUTCOME_TEXT[o].meaning },
									OUTCOME_TEXT[o].label,
								),
							),
						),
					),
					h(
						"tbody",
						undefined,
						...TIERS.map((tier) => {
							const tally = tallies.get(tier);
							return h(
								"tr",
								undefined,
								h("th", { scope: "row" }, capitalize(tier)),
								...OUTCOMES.map((o) =>
									h(
										"td",
										{ class: "num", "data-label": OUTCOME_TEXT[o].label },
										String(tally?.[o] ?? 0),
									),
								),
							);
						}),
					),
				),
			),
			h(
				"dl",
				{ class: "outcome-key" },
				...OUTCOMES.map((o) =>
					h(
						"div",
						undefined,
						h("dt", undefined, OUTCOME_TEXT[o].label),
						h("dd", undefined, OUTCOME_TEXT[o].meaning),
					),
				),
			),
		),
		h(
			"details",
			{ class: "card" },
			h(
				"summary",
				undefined,
				`Every probe in the last ${days} (${points.length.toLocaleString("en-US")})`,
			),
			probeTable(points, dst),
		),
	];
}

function reasonsTable(rows: ReturnType<typeof declineReasons>): HTMLElement {
	return h(
		"div",
		{ class: "table-scroll" },
		h(
			"table",
			{ class: "data reasons" },
			h(
				"thead",
				undefined,
				h(
					"tr",
					undefined,
					h("th", { scope: "col" }, "Reason"),
					h("th", { scope: "col" }, "Retry"),
					h("th", { scope: "col", class: "num" }, "Count"),
					h("th", { scope: "col" }, "Last seen"),
				),
			),
			h(
				"tbody",
				undefined,
				...rows.map((r) =>
					h(
						"tr",
						undefined,
						h(
							"th",
							{ scope: "row" },
							humanizeCode(r.reason),
							h("span", { class: "mono fine" }, ` ${r.reason}`),
						),
						h("td", { "data-label": "Retry" }, retryText(r.retryClassification)),
						h("td", { class: "num", "data-label": "Count" }, String(r.count)),
						h("td", { "data-label": "Last seen" }, formatDayTime(r.lastSeen)),
					),
				),
			),
		),
	);
}

function probeTable(
	points: CorridorHistory["points"],
	dst: SnapshotAsset | undefined,
): HTMLElement {
	return h(
		"div",
		{ class: "table-scroll tall" },
		h(
			"table",
			{ class: "data probes" },
			h(
				"thead",
				undefined,
				h(
					"tr",
					undefined,
					h("th", { scope: "col" }, "Probed"),
					h("th", { scope: "col" }, "Tier"),
					h("th", { scope: "col" }, "Outcome"),
					h("th", { scope: "col", class: "num" }, "Best spread"),
					h("th", { scope: "col", class: "num" }, "Operators"),
					h("th", { scope: "col", class: "num" }, "First quote"),
					h("th", { scope: "col" }, "Declines"),
				),
			),
			h(
				"tbody",
				undefined,
				...[...points]
					.reverse()
					.map((p) =>
						h(
							"tr",
							undefined,
							h("td", undefined, formatDayTime(Date.parse(p.probedAt))),
							h("td", undefined, `${capitalize(p.tier)} · ${amountText(p.fulfillmentAmount, dst)}`),
							h("td", undefined, outcomeChip(p.outcome)),
							h("td", { class: "num" }, p.outcome === "quoted" ? formatBps(p.bestSpreadBps) : "–"),
							h("td", { class: "num" }, String(p.operatorCount)),
							h("td", { class: "num" }, formatMs(p.firstQuoteMs)),
							h("td", undefined, declineList(p.declines)),
						),
					),
			),
		),
	);
}

// ---------------------------------------------------------------------------
// Wiring

function onRouteChange(): void {
	const next = parseRoute(window.location.hash);
	const leavingOverview = state.route.kind === "overview" && next.kind === "corridor";
	if (leavingOverview) state.overviewScroll = window.scrollY;
	state.route = next;
	render();
	if (next.kind === "overview" && state.activeCell !== null) {
		const cell = main.querySelector<HTMLElement>(`[data-id="${CSS.escape(state.activeCell)}"]`);
		cell?.focus({ preventScroll: true });
	}
}

function tickAges(): void {
	const now = Date.now();
	for (const el of document.querySelectorAll<HTMLElement>("[data-age]")) {
		const iso = el.dataset.age;
		if (iso !== undefined) el.textContent = formatAge(iso, now);
	}
	renderBanners();
}

function scheduleRefresh(): void {
	const load = state.load;
	const minutes = load.kind === "ready" ? load.board.snapshot.tickIntervalMinutes : 1;
	window.setTimeout(() => {
		if (document.visibilityState === "visible") void loadSnapshot().then(scheduleRefresh);
		else scheduleRefresh();
	}, Math.max(1, minutes) * 60_000);
}

window.addEventListener("hashchange", onRouteChange);
window.addEventListener("scroll", hideTip, { passive: true });
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible" && state.load.kind === "ready") {
		const age = snapshotAgeMs(state.load.board.snapshot, Date.now());
		if (age > state.load.board.snapshot.tickIntervalMinutes * 60_000) void loadSnapshot();
	}
});
window.setInterval(tickAges, 30_000);

render();
void loadSnapshot().then(scheduleRefresh);
