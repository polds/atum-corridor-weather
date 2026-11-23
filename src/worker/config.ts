import { z } from "zod";
import { cronIntervalMinutes } from "../domain/cron";
import { probesPlannedPerTick, SUBREQUEST_RESERVE, type TierAmounts } from "../domain/schedule";
import type { AlertSeverity } from "../domain/snapshot";
import { AMOUNT_TIERS, type Network } from "../domain/types";
import { requestsPerProbe } from "../gateway/probe";
import type { WebhookFormat } from "../notify/webhook";

/** The value `MAINNET_ACK` must hold before `NETWORK=mainnet` is accepted. */
export const MAINNET_ACK = "cadence-and-publishing-agreed";

/** The only remote gateway each network may use. */
const GATEWAY_ORIGINS: Readonly<Record<Network, string>> = {
	testnet: "https://payment-gw.production-testnet.atum.xyz",
	mainnet: "https://payment-gw.production-mainnet.atum.xyz",
};

/** Hosts of a local stand-in gateway, such as `test/e2e/stub-gateway.mjs`. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * `GATEWAY_URL` is the network's gateway origin or a plain-HTTP loopback origin,
 * so a testnet label can never point at another network's gateway.
 */
function isGatewayFor(network: Network, gatewayUrl: string): boolean {
	if (!URL.canParse(gatewayUrl)) return false;
	const url = new URL(gatewayUrl);
	if (`${url.origin}/` !== url.href) return false;
	return (
		url.origin === GATEWAY_ORIGINS[network] ||
		(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
	);
}

/** An `https:` URL, or `http:` on a loopback host for local runs. */
function isPublicOrLoopbackUrl(text: string): boolean {
	if (!URL.canParse(text)) return false;
	const url = new URL(text);
	return (
		url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
	);
}

/** Where the canary posts alert changes. */
export interface AlertWebhook {
	/** A secret. Log only its origin. */
	readonly url: string;
	readonly format: WebhookFormat;
}

export interface Config {
	readonly network: Network;
	readonly gatewayUrl: string;
	readonly repositoryUrl: string;
	readonly probeEnabled: boolean;
	/** Minutes between ticks, read from the probe cron. The probe cadence. */
	readonly tickIntervalMinutes: number;
	/** A tick publishes the snapshot when its slot index is a multiple of this. */
	readonly publishEveryTicks: number;
	/** `tickIntervalMinutes * publishEveryTicks`. How often the snapshot and its alerts are rebuilt. */
	readonly publishIntervalMinutes: number;
	/** `PROBES_PER_TICK` as configured. A tick runs `probesPlannedPerTick`. */
	readonly probesPerTick: number;
	/** Subrequests one invocation may make. 50 on Workers Free, 10,000 on Workers Paid. */
	readonly subrequestLimit: number;
	/** The probes a tick runs: `probesPerTick`, capped by what `subrequestLimit` covers. At least 1. */
	readonly probesPlannedPerTick: number;
	readonly tierAmounts: TierAmounts;
	readonly pollIntervalMs: number;
	readonly quoteWindowSeconds: number;
	readonly slowQuoteMs: number;
	readonly corridorFilter: RegExp | null;
	/** Days `probe_raw` keeps a probe. 0 keeps every probe. */
	readonly rawRetentionDays: number;
	/** `controller.cron` of the probe Cron Trigger, character for character. */
	readonly probeCron: string;
	/** `controller.cron` of the canary Cron Trigger, character for character. Not `probeCron`. */
	readonly canaryCron: string;
	/** Null when `ALERT_WEBHOOK_URL` is unset: the canary only logs. */
	readonly alertWebhook: AlertWebhook | null;
	readonly alertMinSeverity: AlertSeverity;
	/** The public dashboard, origin plus path with no trailing slash. Null when unset. */
	readonly publicUrl: string | null;
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

/**
 * One of `values`. The message names the allowed values and never quotes the
 * value: a secret pasted into the wrong variable must not reach the published errors.
 */
function oneOf<const T extends readonly [string, ...string[]]>(values: T) {
	return z.enum(values, {
		errorMap: () => ({ message: `must be ${values.join(" or ")}` }),
	});
}

/**
 * A cron expression as Cloudflare passes it in `controller.cron`: five fields of
 * no whitespace, joined by single spaces. `scheduled()` compares it character
 * for character, so a stray space would match no trigger.
 */
const cron = z
	.string({ required_error: "must name a Cron Trigger in wrangler.jsonc" })
	.regex(/^\S+( \S+){4}$/, "must be five cron fields joined by single spaces");

const httpUrl = z
	.string()
	.url()
	.refine((value) => /^https?:\/\//.test(value), "must be an http(s) URL");

const wholeAmount = z
	.string()
	.regex(/^\d+(\.\d+)?$/, "must be a whole-token decimal such as 1 or 0.5")
	.refine((value) => /[1-9]/.test(value), "must be more than zero")
	.refine(
		(value) => (value.split(".")[1] ?? "").replace(/0+$/, "").length <= 18,
		"must have at most 18 fractional digits",
	)
	.refine(
		(value) => (value.split(".")[0] ?? "").replace(/^0+/, "").length <= 24,
		"must have at most 24 integer digits",
	);

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

// An empty value means unset. The message never quotes the value: ALERT_WEBHOOK_URL
// is a secret, and the routes publish configuration errors.
const optionalUrl = z
	.string()
	.default("")
	.refine(
		(value) => value === "" || isPublicOrLoopbackUrl(value),
		"must be an https URL, or an http URL on a loopback host",
	);

const alertWebhookUrl = optionalUrl.transform((value) => (value === "" ? null : value));

/** Origin plus path, without a trailing slash, so links are built one way. */
const publicUrl = optionalUrl.transform((value, context): string | null => {
	if (value === "") return null;
	const url = new URL(value);
	if (url.search !== "" || url.hash !== "") {
		context.addIssue({ code: z.ZodIssueCode.custom, message: "must have no query or fragment" });
		return z.NEVER;
	}
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
});

const envSchema = z
	.object({
		NETWORK: oneOf(["testnet", "mainnet"]),
		MAINNET_ACK: z.string().default(""),
		// Checked against NETWORK below.
		GATEWAY_URL: z.string(),
		REPOSITORY_URL: httpUrl,
		PROBE_ENABLED: oneOf(["true", "false"]).transform((value) => value === "true"),
		PROBES_PER_TICK: integer(1, 200),
		SUBREQUEST_LIMIT: integer(2, 10_000_000).default("50"),
		PUBLISH_EVERY_TICKS: integer(1, 60).default("1"),
		AMOUNT_TIERS: tierAmounts,
		POLL_INTERVAL_MS: integer(100, 10_000),
		QUOTE_WINDOW_SECONDS: integer(1, 60),
		SLOW_QUOTE_MS: integer(0, 600_000),
		CORRIDOR_FILTER: corridorFilter,
		RAW_RETENTION_DAYS: integer(0, 3650).default("14"),
		PROBE_CRON: cron,
		CANARY_CRON: cron,
		ALERT_WEBHOOK_URL: alertWebhookUrl,
		ALERT_WEBHOOK_FORMAT: oneOf(["slack", "json"]).default("slack"),
		ALERT_MIN_SEVERITY: oneOf(["critical", "warning"]).default("critical"),
		PUBLIC_URL: publicUrl,
	})
	.superRefine((env, context) => {
		if (!isGatewayFor(env.NETWORK, env.GATEWAY_URL)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["GATEWAY_URL"],
				message: `NETWORK=${env.NETWORK} needs GATEWAY_URL=${GATEWAY_ORIGINS[env.NETWORK]}, or a loopback origin such as http://127.0.0.1:8789 for a local gateway`,
			});
		}
		if (env.PROBE_CRON === env.CANARY_CRON) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["CANARY_CRON"],
				message: "must differ from PROBE_CRON, or every canary run would also be a tick",
			});
		}
		if (env.NETWORK === "mainnet" && env.MAINNET_ACK !== MAINNET_ACK) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["MAINNET_ACK"],
				message: `NETWORK=mainnet needs MAINNET_ACK=${MAINNET_ACK}, a human decision (docs/DESIGN.md, questions 1 and 4)`,
			});
		}
	})
	// The tick interval has one source, the probe cron, so the two cannot disagree.
	.transform((env, context) => {
		const tickIntervalMinutes = cronIntervalMinutes(env.PROBE_CRON);
		if (tickIntervalMinutes === null) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["PROBE_CRON"],
				message:
					"must fire at one fixed interval, such as */10 * * * *, 0 * * * * or 0 */6 * * *. A step must divide the hour or the day",
			});
			return z.NEVER;
		}
		const perProbe = requestsPerProbe({
			quoteWindowSeconds: env.QUOTE_WINDOW_SECONDS,
			pollIntervalMs: env.POLL_INTERVAL_MS,
		});
		const probesPlanned = probesPlannedPerTick({
			probesPerTick: env.PROBES_PER_TICK,
			subrequestLimit: env.SUBREQUEST_LIMIT,
			requestsPerProbe: perProbe,
		});
		if (probesPlanned === 0) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["SUBREQUEST_LIMIT"],
				message: `leaves no probe per tick: one probe with QUOTE_WINDOW_SECONDS=${env.QUOTE_WINDOW_SECONDS} and POLL_INTERVAL_MS=${env.POLL_INTERVAL_MS} can make ${perProbe} requests, one more reads /v1/defaults, and ${SUBREQUEST_RESERVE} stay unused. Raise SUBREQUEST_LIMIT, shorten QUOTE_WINDOW_SECONDS or lengthen POLL_INTERVAL_MS`,
			});
			return z.NEVER;
		}
		return { ...env, tickIntervalMinutes, probesPlanned };
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
			tickIntervalMinutes: value.tickIntervalMinutes,
			publishEveryTicks: value.PUBLISH_EVERY_TICKS,
			publishIntervalMinutes: value.tickIntervalMinutes * value.PUBLISH_EVERY_TICKS,
			probesPerTick: value.PROBES_PER_TICK,
			subrequestLimit: value.SUBREQUEST_LIMIT,
			probesPlannedPerTick: value.probesPlanned,
			tierAmounts: value.AMOUNT_TIERS,
			pollIntervalMs: value.POLL_INTERVAL_MS,
			quoteWindowSeconds: value.QUOTE_WINDOW_SECONDS,
			slowQuoteMs: value.SLOW_QUOTE_MS,
			corridorFilter: value.CORRIDOR_FILTER,
			rawRetentionDays: value.RAW_RETENTION_DAYS,
			probeCron: value.PROBE_CRON,
			canaryCron: value.CANARY_CRON,
			alertWebhook:
				value.ALERT_WEBHOOK_URL === null
					? null
					: { url: value.ALERT_WEBHOOK_URL, format: value.ALERT_WEBHOOK_FORMAT },
			alertMinSeverity: value.ALERT_MIN_SEVERITY,
			publicUrl: value.PUBLIC_URL,
		},
	};
}
