/**
 * Tiny DOM helpers. Text always goes in through `textContent`, never `innerHTML`,
 * because labels come from the network.
 */

type Child = Node | string | number | null | undefined | false | readonly Child[];
type AttrValue = string | number | boolean | null | undefined;
type Listener = (event: Event) => void;
export type Attrs = Readonly<Record<string, AttrValue | Listener>>;

const isChildList = (c: Child): c is readonly Child[] => Array.isArray(c);

function apply(el: Element, attrs: Attrs | undefined, children: readonly Child[]): void {
	if (attrs !== undefined) {
		for (const [key, value] of Object.entries(attrs)) {
			if (typeof value === "function") el.addEventListener(key.slice(2), value);
			else if (value === true) el.setAttribute(key, "");
			else if (value !== false && value !== null && value !== undefined)
				el.setAttribute(key, String(value));
		}
	}
	for (const child of children) {
		if (child === null || child === undefined || child === false) continue;
		if (isChildList(child)) apply(el, undefined, child);
		else el.append(typeof child === "number" ? String(child) : child);
	}
}

export function h<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs?: Attrs,
	...children: readonly Child[]
): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	apply(el, attrs, children);
	return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function s<K extends keyof SVGElementTagNameMap>(
	tag: K,
	attrs?: Attrs,
	...children: readonly Child[]
): SVGElementTagNameMap[K] {
	const el = document.createElementNS(SVG_NS, tag);
	apply(el, attrs, children);
	return el;
}

export type IconName = "fair" | "cloudy" | "stormy" | "unknown" | "warning" | "critical";

/** A glyph from the sprite in index.html. Decorative unless it carries a label. */
export function icon(name: IconName, cls = "ico"): SVGSVGElement {
	return s(
		"svg",
		{ class: `${cls} ico-${name}`, "aria-hidden": "true", focusable: "false" },
		s("use", { href: `#i-${name}` }),
	);
}

// ---------------------------------------------------------------------------
// The one floating tooltip. It repeats what is already in labels and tables,
// so it is hidden from assistive technology.

let tip: HTMLDivElement | null = null;

function tipElement(): HTMLDivElement {
	if (tip === null) {
		tip = h("div", { class: "tip", "aria-hidden": "true", hidden: true });
		document.body.append(tip);
	}
	return tip;
}

/** Shows the tooltip next to a viewport rectangle, flipping to stay on screen. */
export function showTip(
	content: readonly Child[],
	anchor: { left: number; right: number; top: number; bottom: number },
): void {
	const el = tipElement();
	el.replaceChildren();
	apply(el, undefined, content);
	el.hidden = false;
	const margin = 8;
	const { width, height } = el.getBoundingClientRect();
	const vw = document.documentElement.clientWidth;
	const vh = document.documentElement.clientHeight;
	const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
	let left: number;
	let top = anchor.top;
	if (anchor.right + margin + width <= vw - margin) left = anchor.right + margin;
	else if (anchor.left - margin - width >= margin) left = anchor.left - margin - width;
	else {
		left = clamp((anchor.left + anchor.right) / 2 - width / 2, margin, vw - width - margin);
		top = anchor.bottom + margin;
		if (top + height > vh - margin) top = anchor.top - margin - height;
	}
	el.style.left = `${Math.round(left)}px`;
	el.style.top = `${Math.round(clamp(top, margin, vh - height - margin))}px`;
}

export function hideTip(): void {
	if (tip !== null) tip.hidden = true;
}

/** One tooltip row: a key mark, a strong value, then a muted label. */
export function tipRow(value: string, label: string, keyClass?: string): HTMLElement {
	return h(
		"div",
		{ class: "tip-row" },
		keyClass === undefined ? null : h("span", { class: `tip-key ${keyClass}` }),
		h("strong", undefined, value),
		h("span", { class: "tip-label" }, label),
	);
}
