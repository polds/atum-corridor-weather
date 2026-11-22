import { z } from "zod";
import type { TierAmounts } from "../domain/schedule";
import { AMOUNT_TIERS, type Network } from "../domain/types";

/** The value `MAINNET_ACK` must hold before `NETWORK=mainnet` is accepted. */
export const MAINNET_ACK = "cadence-and-publishing-agreed";

export interface Config {
	readonly network: Network;
	readonly gatewayUrl: string;
	readonly repositoryUrl: string;
	readonly probeEnabled: boolean;
	readonly tickIntervalMinutes: number;
	readonly probesPerTick: number;
	readonly tierAmounts: TierAmounts;
	readonly pollIntervalMs: number;
	readonly quoteWindowSeconds: number;
	readonly slowQuoteMs: number;
	readonly corridorFilter: RegExp | null;
	/** Days `probe_raw` keeps a probe. 0 keeps every probe. */
	readonly rawRetentionDays: number;
}

export type ConfigResult =
	| { readonly ok: true; readonly config: Config }
	| { readonly ok: false; readonly errors: readonly string[] };

function integer(min: number, max: number) {
	return z
		.string()
		.regex(/^\d+$/, "must be a whole number")
		.transform(Number)
		.pipe(z.number().int().min(min).max(max));
}

const httpUrl = z
	.string()
	.url()
	.refine((value) => /^https?:\/\//.test(value), "must be an http(s) URL");

const wholeAmount = z
	.string()
	.regex(/^\d+(\.\d+)?$/, "must be a whole-token decimal such as 1 or 0.5")
	.refine((value) => /[1-9]/.test(value), "must be more than zero");

const tierAmounts = z
	.string()
	.transform((text, context): unknown => {
		try {
			return JSON.parse(text);
		} catch {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "must be JSON" });
			return z.NEVER;
		}
	})
	.pipe(z.record(z.enum(AMOUNT_TIERS), wholeAmount))
	.refine((tiers) => Object.keys(tiers).length > 0, "must name at least one tier");

const corridorFilter = z
	.string()
	.default("")
	.transform((pattern, context): RegExp | null => {
		if (pattern === "") return null;
		try {
			return new RegExp(pattern);
		} catch {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "must be a valid regular expression",
			});
			return z.NEVER;
		}
	});

const envSchema = z
	.object({
		NETWORK: z.enum(["testnet", "mainnet"]),
		MAINNET_ACK: z.string().default(""),
		GATEWAY_URL: httpUrl,
		REPOSITORY_URL: httpUrl,
		PROBE_ENABLED: z.enum(["true", "false"]).transform((value) => value === "true"),
		TICK_INTERVAL_MINUTES: integer(1, 1440),
		PROBES_PER_TICK: integer(1, 200),
		AMOUNT_TIERS: tierAmounts,
		POLL_INTERVAL_MS: integer(100, 10_000),
		QUOTE_WINDOW_SECONDS: integer(1, 60),
		SLOW_QUOTE_MS: integer(0, 600_000),
		CORRIDOR_FILTER: corridorFilter,
		RAW_RETENTION_DAYS: integer(0, 3650).default("14"),
	})
	.superRefine((env, context) => {
		if (env.NETWORK === "mainnet" && env.MAINNET_ACK !== MAINNET_ACK) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["MAINNET_ACK"],
				message: `NETWORK=mainnet needs MAINNET_ACK=${MAINNET_ACK}, a human decision (docs/DESIGN.md, questions 1 and 4)`,
			});
		}
	});

/** Parses the Worker's environment variables. Bindings in `env` are ignored. */
export function parseConfig(env: unknown): ConfigResult {
	const parsed = envSchema.safeParse(env);
	if (!parsed.success) {
		return {
			ok: false,
			errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
		};
	}
	const value = parsed.data;
	return {
		ok: true,
		config: {
			network: value.NETWORK,
			gatewayUrl: value.GATEWAY_URL,
			repositoryUrl: value.REPOSITORY_URL,
			probeEnabled: value.PROBE_ENABLED,
			tickIntervalMinutes: value.TICK_INTERVAL_MINUTES,
			probesPerTick: value.PROBES_PER_TICK,
			tierAmounts: value.AMOUNT_TIERS,
			pollIntervalMs: value.POLL_INTERVAL_MS,
			quoteWindowSeconds: value.QUOTE_WINDOW_SECONDS,
			slowQuoteMs: value.SLOW_QUOTE_MS,
			corridorFilter: value.CORRIDOR_FILTER,
			rawRetentionDays: value.RAW_RETENTION_DAYS,
		},
	};
}
