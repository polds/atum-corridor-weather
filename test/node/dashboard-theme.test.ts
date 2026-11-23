import { describe, expect, it } from "vitest";
import {
	effectiveTheme,
	parseTheme,
	readStoredTheme,
	storeTheme,
	THEME_STORAGE_KEY,
	type Theme,
	toggledChoice,
} from "../../dashboard/src/theme";

function memoryStorage(initial: Record<string, string> = {}) {
	const items = new Map(Object.entries(initial));
	return {
		items,
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => void items.set(key, value),
		removeItem: (key: string) => void items.delete(key),
	};
}

const refusing = {
	getItem: () => {
		throw new Error("storage is blocked");
	},
	setItem: () => {
		throw new Error("storage is blocked");
	},
	removeItem: () => {
		throw new Error("storage is blocked");
	},
};

describe("the theme choice", () => {
	it("follows the system until the reader chooses", () => {
		expect(effectiveTheme(null, "dark")).toBe("dark");
		expect(effectiveTheme(null, "light")).toBe("light");
		expect(effectiveTheme("light", "dark")).toBe("light");
	});

	it.each([
		["light", "dark"],
		["dark", "light"],
	] as const)("switches a %s system to %s on the first press", (system, other) => {
		const choice = toggledChoice(null, system);
		expect(choice).toBe(other);
		expect(effectiveTheme(choice, system)).toBe(other);
	});

	it("always changes the theme on screen, and a second press undoes the first", () => {
		const themes: readonly Theme[] = ["light", "dark"];
		for (const system of themes) {
			for (const choice of [null, ...themes]) {
				const before = effectiveTheme(choice, system);
				const once = toggledChoice(choice, system);
				expect(effectiveTheme(once, system), `${choice} on ${system}`).not.toBe(before);
				expect(effectiveTheme(toggledChoice(once, system), system)).toBe(before);
			}
		}
	});

	it("keeps no choice that equals the system's, so the page follows the system again", () => {
		expect(toggledChoice("dark", "light")).toBeNull();
		expect(toggledChoice("light", "dark")).toBeNull();
		// The system changed under a stored choice: the press still lands on the other theme.
		expect(toggledChoice("dark", "dark")).toBe("light");
	});
});

describe("the stored theme", () => {
	it("round-trips a choice and forgets it for null", () => {
		const storage = memoryStorage();
		storeTheme(storage, "dark");
		expect(storage.items.get(THEME_STORAGE_KEY)).toBe("dark");
		expect(readStoredTheme(storage)).toBe("dark");
		storeTheme(storage, null);
		expect(storage.items.has(THEME_STORAGE_KEY)).toBe(false);
		expect(readStoredTheme(storage)).toBeNull();
	});

	it("reads anything but light or dark as no choice", () => {
		for (const value of ["", "auto", "DARK", "dark ", "<script>"]) {
			expect(readStoredTheme(memoryStorage({ [THEME_STORAGE_KEY]: value })), value).toBeNull();
		}
		expect(parseTheme(undefined)).toBeNull();
	});

	it("works without storage and with storage that throws", () => {
		expect(readStoredTheme(undefined)).toBeNull();
		expect(readStoredTheme(refusing)).toBeNull();
		expect(() => storeTheme(undefined, "dark")).not.toThrow();
		expect(() => storeTheme(refusing, "dark")).not.toThrow();
		expect(() => storeTheme(refusing, null)).not.toThrow();
	});
});
