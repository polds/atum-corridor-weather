/**
 * Hand-written SVG charts. Colors come from CSS classes so both themes and
 * forced-colors mode restyle them without a redraw.
 */
import { h, hideTip, s, showTip, tipRow } from "./dom";
import { formatDay, formatDayTime } from "./format";
import { type DeclineBucket, dayTicks, niceTicks, readingAt, type SeriesPoint } from "./series";

interface Margins {
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
	readonly left: number;
}

const M: Margins = { top: 14, right: 72, bottom: 26, left: 44 };

interface Frame {
	readonly m: Margins;
	readonly width: number;
	readonly height: number;
	readonly x: (t: number) => number;
	readonly y: (v: number) => number;
	readonly yTicks: readonly number[];
}

function frame(input: {
	width: number;
	height: number;
	start: number;
	end: number;
	yMin: number;
	yMax: number;
	integer: boolean;
	m?: Margins;
}): Frame {
	const m = input.m ?? M;
	const plotW = Math.max(40, input.width - m.left - m.right);
	const plotH = input.height - m.top - m.bottom;
	let yTicks = niceTicks(input.yMin, input.yMax, plotH > 110 ? 4 : 2);
	if (input.integer) yTicks = [...new Set(yTicks.map((v) => Math.round(v)))];
	const lo = Math.min(input.yMin, yTicks[0] ?? 0);
	const hi = Math.max(input.yMax, yTicks[yTicks.length - 1] ?? 1);
	const span = hi - lo || 1;
	return {
		m,
		width: input.width,
		height: input.height,
		yTicks,
		x: (t) => m.left + ((t - input.start) / (input.end - input.start || 1)) * plotW,
		y: (v) => m.top + plotH - ((v - lo) / span) * plotH,
	};
}

function axes(
	f: Frame,
	start: number,
	end: number,
	yFormat: (v: number) => string,
	xLabels = true,
): SVGGElement {
	const M = f.m;
	const g = s("g", { class: "axes", "aria-hidden": "true" });
	const right = f.width - M.right;
	for (const v of f.yTicks) {
		const y = f.y(v);
		g.append(
			s("line", { class: v === 0 ? "baseline" : "grid", x1: M.left, x2: right, y1: y, y2: y }),
			s(
				"text",
				{ class: "tick", x: M.left - 6, y, "text-anchor": "end", "dominant-baseline": "middle" },
				yFormat(v),
			),
		);
	}
	const days = dayTicks(start, end);
	const every = Math.ceil(days.length / Math.max(1, Math.floor((right - M.left) / 56)));
	days.forEach((t, i) => {
		const x = f.x(t);
		g.append(s("line", { class: "grid", x1: x, x2: x, y1: M.top, y2: f.height - M.bottom }));
		if (xLabels && i % every === 0) {
			g.append(
				s(
					"text",
					{ class: "tick", x, y: f.height - M.bottom + 16, "text-anchor": "middle" },
					formatDay(t),
				),
			);
		}
	});
	return g;
}

export interface LineSeries {
	readonly label: string;
	/** CSS class that sets the stroke and fill for this series. */
	readonly cls: string;
	readonly points: readonly SeriesPoint[];
}

export interface LineChartOptions {
	readonly label: string;
	readonly series: readonly LineSeries[];
	readonly start: number;
	readonly end: number;
	readonly width: number;
	readonly height: number;
	/** Hold each value until the next reading, for counts. */
	readonly step: boolean;
	readonly integer: boolean;
	readonly yFormat: (v: number) => string;
	readonly valueText: (p: SeriesPoint) => string;
	/** Shared top of the y scale, for small multiples. */
	readonly yMax?: number;
	/** Fill under a step line, for a single series. */
	readonly area?: boolean;
	/** Day labels under the plot. Small multiples show them on the last chart only. */
	readonly xLabels?: boolean;
	/** Series names at the line ends. Off for a single series, which the title names. */
	readonly directLabels?: boolean;
}

function linePath(
	points: readonly SeriesPoint[],
	f: Frame,
	step: boolean,
): { d: string; area: string; dots: [number, number][] } {
	let d = "";
	let area = "";
	const base = round(f.y(0));
	const dots: [number, number][] = [];
	let run: [number, number][] = [];
	const flush = (): void => {
		const first = run[0];
		if (step && run.length > 1 && first !== undefined) {
			area += `M${first[0]},${base}V${first[1]}`;
			for (const [x, y] of run.slice(1)) area += `H${x}V${y}`;
			area += `V${base}Z`;
		}
		if (run.length === 1) {
			const only = run[0];
			if (only !== undefined) dots.push(only);
		} else if (run.length > 1) {
			run.forEach(([x, y], i) => {
				if (i === 0) d += `M${x},${y}`;
				else {
					const prev = run[i - 1];
					if (step && prev !== undefined) d += `H${x}V${y}`;
					else d += `L${x},${y}`;
				}
			});
		}
		run = [];
	};
	for (const p of points) {
		if (p.v === null) flush();
		else run.push([round(f.x(p.t)), round(f.y(p.v))]);
	}
	flush();
	return { d, area, dots };
}

const round = (n: number): number => Math.round(n * 10) / 10;

export function lineChart(o: LineChartOptions): SVGSVGElement {
	const values = o.series
		.flatMap((se) => se.points.map((p) => p.v))
		.filter((v): v is number => v !== null);
	const f = frame({
		width: o.width,
		height: o.height,
		start: o.start,
		end: o.end,
		yMin: Math.min(0, ...values),
		yMax: o.yMax ?? (values.length === 0 ? 1 : Math.max(...values)),
		integer: o.integer,
		m: {
			top: o.xLabels === false ? 8 : M.top,
			right: o.directLabels === false ? 12 : M.right,
			bottom: o.xLabels === false ? 6 : M.bottom,
			left: M.left,
		},
	});
	const m = f.m;
	const svg = s("svg", {
		class: "chart",
		width: o.width,
		height: o.height,
		viewBox: `0 0 ${o.width} ${o.height}`,
		role: "img",
		"aria-label": o.label,
		tabindex: 0,
	});
	svg.append(axes(f, o.start, o.end, o.yFormat, o.xLabels !== false));

	const labels: { y: number; text: string }[] = [];
	for (const se of o.series) {
		const { d, area, dots } = linePath(se.points, f, o.step);
		const g = s("g", { class: `series ${se.cls}` });
		if (o.area === true && area !== "") g.append(s("path", { class: "area", d: area }));
		if (d !== "") g.append(s("path", { class: "line", d }));
		for (const [x, y] of dots) g.append(s("circle", { class: "dot", cx: x, cy: y, r: 3 }));
		const last = [...se.points].reverse().find((p) => p.v !== null);
		if (last !== undefined && last.v !== null) {
			const x = f.x(last.t);
			const y = f.y(last.v);
			g.append(s("circle", { class: "end", cx: x, cy: y, r: 4 }));
			if (o.directLabels !== false) labels.push({ y, text: se.label });
		}
		svg.append(g);
	}
	// Direct labels at the right edge, dropped where they would collide; the legend still names every series.
	let lastY = Number.NEGATIVE_INFINITY;
	for (const l of [...labels].sort((a, b) => a.y - b.y)) {
		if (l.y - lastY < 13) continue;
		svg.append(
			s(
				"text",
				{
					class: "direct",
					x: o.width - m.right + 8,
					y: l.y,
					"dominant-baseline": "middle",
					"aria-hidden": "true",
				},
				l.text,
			),
		);
		lastY = l.y;
	}

	const times = [...new Set(o.series.flatMap((se) => se.points.map((p) => p.t)))].sort(
		(a, b) => a - b,
	);
	const cross = s("line", {
		class: "cross",
		y1: m.top,
		y2: o.height - m.bottom,
		visibility: "hidden",
	});
	svg.append(cross);
	const show = (t: number): void => {
		const x = f.x(t);
		cross.setAttribute("x1", String(x));
		cross.setAttribute("x2", String(x));
		cross.setAttribute("visibility", "visible");
		const rows = o.series.map((se) => {
			const p = readingAt(se.points, t);
			return tipRow(
				p === undefined ? "no reading" : o.valueText(p),
				se.label,
				`key-line ${se.cls}`,
			);
		});
		const box = svg.getBoundingClientRect();
		showTip([h("div", { class: "tip-head" }, formatDayTime(t)), ...rows], {
			left: box.left + x,
			right: box.left + x,
			top: box.top + m.top,
			bottom: box.top + m.top,
		});
	};
	const hide = (): void => {
		cross.setAttribute("visibility", "hidden");
		hideTip();
	};
	attachScrubber(svg, times, f.x, show, hide);
	return svg;
}

/** Pointer and arrow-key scrubbing over a sorted list of x positions. */
function attachScrubber(
	svg: SVGSVGElement,
	keys: readonly number[],
	x: (key: number) => number,
	show: (key: number) => void,
	hide: () => void,
): void {
	if (keys.length === 0) return;
	let index = keys.length - 1;
	const nearest = (px: number): number => {
		let best = 0;
		keys.forEach((k, i) => {
			const bestKey = keys[best];
			if (bestKey !== undefined && Math.abs(x(k) - px) < Math.abs(x(bestKey) - px)) best = i;
		});
		return best;
	};
	const at = (i: number): void => {
		index = Math.max(0, Math.min(keys.length - 1, i));
		const key = keys[index];
		if (key !== undefined) show(key);
	};
	svg.addEventListener("pointermove", (e) => {
		const box = svg.getBoundingClientRect();
		at(nearest(e.clientX - box.left));
	});
	svg.addEventListener("pointerleave", hide);
	svg.addEventListener("focus", () => at(index));
	svg.addEventListener("blur", hide);
	svg.addEventListener("keydown", (e) => {
		if (e.key === "ArrowLeft") at(index - 1);
		else if (e.key === "ArrowRight") at(index + 1);
		else if (e.key === "Home") at(0);
		else if (e.key === "End") at(keys.length - 1);
		else if (e.key === "Escape") hide();
		else return;
		e.preventDefault();
	});
}

function roundedTop(x: number, y: number, w: number, hgt: number, r: number): string {
	const rr = Math.min(r, w / 2, hgt);
	return `M${x},${y + hgt}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + hgt}Z`;
}

export interface DeclineChartOptions {
	readonly label: string;
	readonly buckets: readonly DeclineBucket[];
	readonly start: number;
	readonly end: number;
	readonly width: number;
	readonly height: number;
	readonly retryLabel: string;
	readonly otherLabel: string;
}

/** Stacked columns: declines a retry could change at the base, the rest on top. */
export function declineChart(o: DeclineChartOptions): SVGSVGElement {
	const max = Math.max(1, ...o.buckets.map((b) => b.retryable + b.other));
	const f = frame({
		width: o.width,
		height: o.height,
		start: o.start,
		end: o.end,
		yMin: 0,
		yMax: max,
		integer: true,
	});
	const svg = s("svg", {
		class: "chart",
		width: o.width,
		height: o.height,
		viewBox: `0 0 ${o.width} ${o.height}`,
		role: "img",
		"aria-label": o.label,
		tabindex: 0,
	});
	svg.append(axes(f, o.start, o.end, (v) => String(v)));
	const base = f.y(0);
	const marks = s("g");
	const hits = s("g", { class: "hits" });
	const highlight = s("rect", {
		class: "hover-band",
		visibility: "hidden",
		y: M.top,
		height: o.height - M.top - M.bottom,
	});
	svg.append(highlight, marks, hits);
	for (const b of o.buckets) {
		const slot = f.x(b.end) - f.x(b.start);
		const w = Math.max(2, Math.min(24, slot - 2));
		const x = f.x(b.start) + (slot - w) / 2;
		const hRetry = base - f.y(b.retryable);
		const hOther = base - f.y(b.other);
		if (b.retryable > 0) {
			const top = b.other === 0;
			marks.append(
				top
					? s("path", { class: "bar s-retry", d: roundedTop(x, base - hRetry, w, hRetry, 4) })
					: s("rect", { class: "bar s-retry", x, y: base - hRetry, width: w, height: hRetry }),
			);
		}
		if (b.other > 0) {
			const gap = b.retryable > 0 ? 2 : 0;
			const y = base - hRetry - gap - hOther;
			marks.append(s("path", { class: "bar s-other", d: roundedTop(x, y, w, hOther, 4) }));
		}
	}
	const show = (i: number): void => {
		const b = o.buckets[i];
		if (b === undefined) return;
		const x = f.x(b.start);
		const w = f.x(b.end) - x;
		highlight.setAttribute("x", String(x));
		highlight.setAttribute("width", String(w));
		highlight.setAttribute("visibility", "visible");
		const box = svg.getBoundingClientRect();
		showTip(
			[
				h(
					"div",
					{ class: "tip-head" },
					`${formatDayTime(b.start)} to ${formatDayTime(b.end).split(", ")[1] ?? ""}`,
				),
				tipRow(String(b.other), o.otherLabel, "key-rect s-other"),
				tipRow(String(b.retryable), o.retryLabel, "key-rect s-retry"),
			],
			{
				left: box.left + x,
				right: box.left + x + w,
				top: box.top + M.top,
				bottom: box.top + M.top,
			},
		);
	};
	const hide = (): void => {
		highlight.setAttribute("visibility", "hidden");
		hideTip();
	};
	attachScrubber(
		svg,
		o.buckets.map((_, i) => i),
		(i) => {
			const b = o.buckets[i];
			return b === undefined ? 0 : (f.x(b.start) + f.x(b.end)) / 2;
		},
		show,
		hide,
	);
	return svg;
}

export interface SizeRow {
	readonly label: string;
	readonly sublabel: string;
	readonly latest: number | null;
	readonly range: { readonly min: number; readonly max: number } | null;
	readonly emptyText: string;
}

/**
 * Best spread per amount tier: a bar for the latest reading and a thin
 * whisker for the window's lowest-to-highest range.
 */
export function sizeChart(o: {
	readonly label: string;
	readonly rows: readonly SizeRow[];
	readonly width: number;
	readonly format: (v: number) => string;
}): SVGSVGElement {
	const labelW = Math.min(150, Math.max(96, o.width * 0.28));
	const valueW = 84;
	const rowH = 40;
	const top = 6;
	const height = top + o.rows.length * rowH + 22;
	const values = o.rows
		.flatMap((r) => [r.latest, r.range?.min ?? null, r.range?.max ?? null])
		.filter((v): v is number => v !== null);
	const ticks = niceTicks(
		Math.min(0, ...values),
		values.length === 0 ? 1 : Math.max(...values),
		Math.max(2, Math.floor((o.width - labelW - valueW) / 72)),
	);
	const lo = Math.min(0, ticks[0] ?? 0);
	const hi = Math.max(1, ticks[ticks.length - 1] ?? 1);
	const plotL = labelW;
	const plotR = o.width - valueW;
	const x = (v: number): number => plotL + ((v - lo) / (hi - lo || 1)) * (plotR - plotL);
	const svg = s("svg", {
		class: "chart",
		width: o.width,
		height,
		viewBox: `0 0 ${o.width} ${height}`,
		role: "img",
		"aria-label": o.label,
	});
	const axisY = top + o.rows.length * rowH;
	for (const t of ticks) {
		svg.append(
			s("line", { class: t === 0 ? "baseline" : "grid", x1: x(t), x2: x(t), y1: top, y2: axisY }),
			s(
				"text",
				{ class: "tick", x: x(t), y: axisY + 15, "text-anchor": "middle", "aria-hidden": "true" },
				o.format(t),
			),
		);
	}
	o.rows.forEach((r, i) => {
		const cy = top + i * rowH + rowH / 2;
		svg.append(
			s("text", { class: "row-label", x: 0, y: cy - 6, "dominant-baseline": "middle" }, r.label),
			s("text", { class: "row-sub", x: 0, y: cy + 9, "dominant-baseline": "middle" }, r.sublabel),
		);
		if (r.range !== null) {
			const x1 = x(r.range.min);
			const x2 = x(r.range.max);
			svg.append(
				s("line", { class: "whisker", x1, x2, y1: cy + 11, y2: cy + 11 }),
				s("line", { class: "whisker", x1, x2: x1, y1: cy + 7, y2: cy + 15 }),
				s("line", { class: "whisker", x1: x2, x2, y1: cy + 7, y2: cy + 15 }),
			);
		}
		if (r.latest === null) {
			svg.append(
				s(
					"text",
					{ class: "row-value muted", x: plotL + 4, y: cy - 3, "dominant-baseline": "middle" },
					r.emptyText,
				),
			);
			return;
		}
		const x0 = x(0);
		const xv = x(r.latest);
		const w = Math.max(1, Math.abs(xv - x0));
		const barH = 14;
		const left = Math.min(x0, xv);
		const d =
			r.latest >= 0
				? `M${left},${cy - 3 - barH / 2}H${left + w - Math.min(4, w)}Q${left + w},${cy - 3 - barH / 2} ${left + w},${cy - 3 - barH / 2 + Math.min(4, w)}V${cy - 3 + barH / 2 - Math.min(4, w)}Q${left + w},${cy - 3 + barH / 2} ${left + w - Math.min(4, w)},${cy - 3 + barH / 2}H${left}Z`
				: `M${left + w},${cy - 3 - barH / 2}H${left + Math.min(4, w)}Q${left},${cy - 3 - barH / 2} ${left},${cy - 3 - barH / 2 + Math.min(4, w)}V${cy - 3 + barH / 2 - Math.min(4, w)}Q${left},${cy - 3 + barH / 2} ${left + Math.min(4, w)},${cy - 3 + barH / 2}H${left + w}Z`;
		svg.append(
			s("path", { class: "bar s-size", d }),
			s(
				"text",
				{ class: "row-value", x: Math.max(xv, x0) + 6, y: cy - 3, "dominant-baseline": "middle" },
				o.format(r.latest),
			),
		);
	});
	return svg;
}
