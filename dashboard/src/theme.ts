/**
 * The reader's theme choice. With no stored choice the page follows the system,
 * through `color-scheme` in styles.css. A stored choice sets `data-theme` on the
 * root element, which pins `color-scheme` to it. This file touches no DOM, so it
 * can be tested outside a browser. theme-dom.ts holds the parts that do.
 */
export type Theme = "light" | "dark";

/** Where the choice is kept. Only ever "light" or "dark"; absent means follow the system. */
export const THEME_STORAGE_KEY = "corridor-weather:theme";

export function parseTheme(value: string | null | undefined): Theme | null {
	return value === "light" || value === "dark" ? value : null;
}

/** The theme on screen: the reader's choice, or the system's when there is none. */
export function effectiveTheme(choice: Theme | null, system: Theme): Theme {
	return choice ?? system;
}

/**
 * The choice one press of the button makes: the other theme. A choice equal to
 * the system's is not kept, so the page follows the system again and a later
 * change of the system setting still reaches it.
 */
export function toggledChoice(choice: Theme | null, system: Theme): Theme | null {
	const next: Theme = effectiveTheme(choice, system) === "dark" ? "light" : "dark";
	return next === system ? null : next;
}

/** The part of the browser's `localStorage` the choice needs. */
export interface ThemeStore {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

/** The stored choice. Null when there is none or storage cannot be read. */
export function readStoredTheme(storage: Pick<ThemeStore, "getItem"> | undefined): Theme | null {
	try {
		return parseTheme(storage?.getItem(THEME_STORAGE_KEY));
	} catch {
		return null;
	}
}

/** Keeps the choice, or forgets it for null. A browser that refuses storage keeps it for this page only. */
export function storeTheme(
	storage: Pick<ThemeStore, "setItem" | "removeItem"> | undefined,
	choice: Theme | null,
): void {
	try {
		if (choice === null) storage?.removeItem(THEME_STORAGE_KEY);
		else storage?.setItem(THEME_STORAGE_KEY, choice);
	} catch {
		// Private modes and blocked storage: the choice still applies to this page.
	}
}
