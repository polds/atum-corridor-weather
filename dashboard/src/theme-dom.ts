import type { Theme, ThemeStore } from "./theme";

/** The browser's storage for the choice. Undefined where reading the property itself is refused. */
export function themeStorage(): ThemeStore | undefined {
	try {
		return window.localStorage;
	} catch {
		return undefined;
	}
}

/** Pins the root element to `choice`, or lets it follow the system for null. */
export function applyTheme(root: HTMLElement, choice: Theme | null): void {
	if (choice === null) delete root.dataset.theme;
	else root.dataset.theme = choice;
}
