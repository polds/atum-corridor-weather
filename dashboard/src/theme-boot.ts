/**
 * Runs in <head>, before the first paint: applies a stored theme choice so the
 * page never paints in the other theme first. The page's Content-Security-Policy
 * allows no inline script, so this is its own small file, loaded without `defer`.
 */
import { readStoredTheme } from "./theme";
import { applyTheme, themeStorage } from "./theme-dom";

applyTheme(document.documentElement, readStoredTheme(themeStorage()));
