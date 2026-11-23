#!/usr/bin/env node
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
/**
 * Builds the static dashboard into dist/dashboard: index.html, the app script,
 * the small theme script that runs before the first paint, one CSS file and the
 * favicon. Output names carry a content hash, so the
 * same sources always give the same bytes.
 *
 *   pnpm run build:dashboard
 *   pnpm run build:dashboard --serve [--port=8788] [--fixture=normal|stale|empty|error|schema]
 *
 * `--serve` previews the build and answers the two API routes from the fixture
 * generator in dashboard/fixtures. It is a dev tool: nothing it loads reaches
 * dist/dashboard. While it runs, `GET /__fixture?mode=<mode>` switches fixtures.
 */
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = path.join(ROOT, "dashboard");
const OUT = path.join(ROOT, "dist", "dashboard");
const DEFAULT_REPOSITORY_URL = "https://github.com/polds/atum-corridor-weather";
const BUDGET_GZIP_BYTES = 150 * 1024;
const FIXTURE_MODES = ["normal", "stale", "empty", "error", "schema"];

const args = new Map(
	process.argv.slice(2).map((arg) => {
		const [key, value] = arg.replace(/^--/, "").split("=");
		return [key, value ?? "true"];
	}),
);

function repositoryUrl() {
	const url = process.env.REPOSITORY_URL || DEFAULT_REPOSITORY_URL;
	if (!/^https:\/\/[^\s"'<>]+$/.test(url))
		throw new Error(`REPOSITORY_URL must be an https URL, got ${url}`);
	return url;
}

const escapeAttr = (text) =>
	text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

async function buildDashboard() {
	await rm(OUT, { recursive: true, force: true });
	await mkdir(OUT, { recursive: true });
	const result = await build({
		absWorkingDir: ROOT,
		entryPoints: { app: "dashboard/src/main.ts" },
		bundle: true,
		minify: true,
		format: "esm",
		platform: "browser",
		target: ["es2022"],
		outdir: OUT,
		entryNames: "[name]-[hash]",
		legalComments: "none",
		charset: "utf8",
		metafile: true,
		logLevel: "warning",
	});
	// The theme script runs in <head> as a classic script, before the first paint.
	const boot = await build({
		absWorkingDir: ROOT,
		entryPoints: { theme: "dashboard/src/theme-boot.ts" },
		bundle: true,
		minify: true,
		format: "iife",
		platform: "browser",
		target: ["es2022"],
		outdir: OUT,
		entryNames: "[name]-[hash]",
		legalComments: "none",
		charset: "utf8",
		metafile: true,
		logLevel: "warning",
	});
	const outputs = [result, boot].flatMap((built) =>
		Object.keys(built.metafile.outputs).map((file) => path.basename(file)),
	);
	const js = outputs.find((f) => f.startsWith("app-") && f.endsWith(".js"));
	const themeJs = outputs.find((f) => f.startsWith("theme-") && f.endsWith(".js"));
	const css = outputs.find((f) => f.endsWith(".css"));
	if (js === undefined || themeJs === undefined || css === undefined || outputs.length !== 3)
		throw new Error(`expected app JS, theme JS and one CSS output, got ${outputs.join(", ")}`);

	const url = escapeAttr(repositoryUrl());
	const template = await readFile(path.join(SRC, "index.html"), "utf8");
	const html = template
		.replaceAll("%REPOSITORY_URL%", url)
		.replaceAll("%JS%", js)
		.replaceAll("%THEME_JS%", themeJs)
		.replaceAll("%CSS%", css);
	if (/%[A-Z_]+%/.test(html)) throw new Error("index.html still has an unreplaced placeholder");
	await writeFile(path.join(OUT, "index.html"), html);
	await copyFile(path.join(SRC, "favicon.svg"), path.join(OUT, "favicon.svg"));
	return report();
}

async function report() {
	const rows = [];
	for (const name of (await readdir(OUT)).sort()) {
		const bytes = await readFile(path.join(OUT, name));
		rows.push({ name, raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length });
	}
	const kib = (n) => `${(n / 1024).toFixed(1)} KiB`.padStart(10);
	const width = Math.max(...rows.map((r) => r.name.length));
	console.log(`dist/dashboard${" ".repeat(Math.max(1, width - 12))}      raw      gzip`);
	for (const r of rows) console.log(`  ${r.name.padEnd(width)} ${kib(r.raw)} ${kib(r.gzip)}`);
	const total = rows.reduce((sum, r) => sum + r.gzip, 0);
	console.log(
		`  ${"total".padEnd(width)} ${kib(rows.reduce((s, r) => s + r.raw, 0))} ${kib(total)}  (budget ${kib(BUDGET_GZIP_BYTES).trim()} gzip)`,
	);
	if (total > BUDGET_GZIP_BYTES) throw new Error("the dashboard is over its gzip budget");
}

// ---------------------------------------------------------------------------
// Preview server

async function loadFixtures() {
	const result = await build({
		absWorkingDir: ROOT,
		entryPoints: ["dashboard/fixtures/generate.ts"],
		bundle: true,
		format: "esm",
		platform: "node",
		write: false,
		logLevel: "warning",
	});
	const code = result.outputFiles[0]?.text ?? "";
	return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json",
};

function sendJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

async function serve() {
	const fixtures = await loadFixtures();
	let mode = args.get("fixture") ?? "normal";
	if (!FIXTURE_MODES.includes(mode))
		throw new Error(`--fixture must be one of ${FIXTURE_MODES.join(", ")}`);
	const port = Number(args.get("port") ?? 8788);
	const historyPath = /^\/api\/v1\/corridors\/([^/]+)\/history\.json$/;

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname === "/__fixture") {
			const next = url.searchParams.get("mode") ?? "";
			if (!FIXTURE_MODES.includes(next))
				return sendJson(res, 400, { error: `mode must be one of ${FIXTURE_MODES.join(", ")}` });
			mode = next;
			return sendJson(res, 200, { mode });
		}
		if (url.pathname === "/api/v1/snapshot.json") {
			if (mode === "empty") return sendJson(res, 404, { error: "no snapshot yet" });
			if (mode === "error") return sendJson(res, 500, { error: "fixture failure" });
			const snapshot = fixtures.buildSnapshot(Date.now(), mode === "stale" ? "stale" : "normal");
			return sendJson(res, 200, mode === "schema" ? { ...snapshot, schemaVersion: 2 } : snapshot);
		}
		const match = historyPath.exec(url.pathname);
		if (match !== null) {
			let id;
			try {
				id = decodeURIComponent(match[1] ?? "");
			} catch {
				return sendJson(res, 400, { error: "bad corridor id" });
			}
			const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days") ?? 7) || 7));
			const history = fixtures.buildHistory(
				id,
				Date.now(),
				days,
				mode === "stale" ? "stale" : "normal",
			);
			return history === null
				? sendJson(res, 404, { error: "unknown corridor" })
				: sendJson(res, 200, history);
		}
		if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "not found" });

		const file = path.normalize(
			path.join(OUT, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname)),
		);
		if (!file.startsWith(OUT + path.sep)) {
			res.writeHead(403).end();
			return;
		}
		try {
			if (!(await stat(file)).isFile()) throw new Error("not a file");
			res.writeHead(200, {
				"content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
				"cache-control": "no-store",
			});
			res.end(await readFile(file));
		} catch {
			res.writeHead(404, { "content-type": "text/plain" }).end("not found");
		}
	});
	server.listen(port, "127.0.0.1", () => {
		console.log(`Previewing dist/dashboard with ${mode} fixtures at http://127.0.0.1:${port}/`);
	});
}

await buildDashboard();
if (args.has("serve")) await serve();
