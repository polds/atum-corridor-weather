import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Two projects. `workers` runs inside workerd with a real D1. `node` runs the
 * tests that need Node-only libraries: the real SDK as a conformance oracle and
 * ethers for the probe identity. Neither library ships in the Worker.
 */
const migrations = await readD1Migrations("migrations");

export default defineConfig({
	test: {
		coverage: {
			provider: "istanbul",
			include: ["src/**"],
			// `src/**` also matches dashboard/src. The dashboard is not Worker code.
			exclude: ["dashboard/**"],
			thresholds: { lines: 90, statements: 90, functions: 90, branches: 82 },
		},
		projects: [
			{
				plugins: [
					cloudflareTest({
						wrangler: { configPath: "./wrangler.jsonc" },
						miniflare: {
							// The pool's workerd predates the deploy compatibility date.
							compatibilityDate: "2026-08-15",
							bindings: { TEST_MIGRATIONS: migrations },
						},
					}),
				],
				test: {
					name: "workers",
					include: ["test/**/*.test.ts"],
					exclude: ["test/node/**"],
					setupFiles: ["./test/support/setup.ts"],
				},
			},
			{
				test: {
					name: "node",
					environment: "node",
					include: ["test/node/**/*.test.ts"],
				},
			},
		],
	},
});
