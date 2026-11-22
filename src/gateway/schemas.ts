/**
 * Response schemas for the three gateway routes Corridor Weather calls. Unknown
 * fields are dropped, never rejected. Open string sets stay strings: `status`
 * as sent, and a decline `reason` or `retry_classification` when it is a
 * publishable code (otherwise `OTHER` and null).
 */
import { z } from "zod";
import { isAtomicAmount, toIsoTimestamp } from "../domain/brands";
import type { DefaultsListing, ListedChain, ListedToken } from "../domain/corridors";

function isPresent<T>(value: T | null): value is T {
	return value !== null;
}

const tokenSchema: z.ZodType<ListedToken, z.ZodTypeDef, unknown> = z.object({
	address: z.string().min(1),
	decimals: z.number().int().min(0).max(36),
	/** A ticker such as `USDC.e`: anything longer or stranger is not shown to a reader. */
	symbol: z.string().regex(/^[\w.-]{1,20}$/),
});

const chainSchema: z.ZodType<ListedChain, z.ZodTypeDef, unknown> = z.object({
	escrow_contract: z.string().default(""),
	quote_selector: z.string().default(""),
	fulfillment_proxy: z.string().default(""),
	fulfillment_verifier: z
		.object({ account: z.string().default(""), endpoint: z.string().default("") })
		.default({}),
	tokens: z
		.array(tokenSchema.nullable().catch(null))
		.default([])
		.transform((tokens) => tokens.filter(isPresent)),
});

/** A malformed chain or token is dropped so one bad entry does not stop discovery. */
export const defaultsListingSchema: z.ZodType<DefaultsListing, z.ZodTypeDef, unknown> = z
	.record(z.string(), chainSchema.nullable().catch(null))
	.transform((chains) =>
		Object.fromEntries(
			Object.entries(chains).flatMap(([chainId, chain]) =>
				chain === null ? [] : [[chainId, chain]],
			),
		),
	);

/** `POST /v1/payments/quote-requests`, both the 202 and the 200 shape. */
export const createResponseSchema = z.object({
	/** Goes into the poll path, so only characters that need no encoding there. */
	quote_request_id: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
	status: z.string(),
	/** Absent from a gateway that predates the field, which never replays. */
	idempotent_replay: z.boolean().default(false),
});
export type CreateResponse = z.infer<typeof createResponseSchema>;

const timestampSchema = z.string().transform((value, context) => {
	const iso = toIsoTimestamp(value);
	if (iso === null) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: "not a timestamp" });
		return z.NEVER;
	}
	return iso;
});

const quoteSchema = z.object({
	quote_id: z.string().min(1),
	fulfillment_quote: z.object({
		settler_address: z.string().min(1),
		source_amount: z.string().refine(isAtomicAmount, "not an atomic amount"),
		award_deadline: timestampSchema,
	}),
});

/** The reason the Atum docs prescribe for a decline reason the client does not recognise. */
const OTHER_REASON = "OTHER";
/** Decline entries kept from one response. The rest are summed into one `OTHER` entry. */
const MAX_DECLINES = 50;

/**
 * A decline code the snapshot may publish: short, upper case, and with no hex
 * run long enough to be an operator address or a hash.
 */
function isPublishableCode(code: string): boolean {
	return /^[A-Z][A-Z0-9_]{0,47}$/.test(code) && !/[0-9A-F]{32,}/.test(code);
}

const declineSchema = z.object({
	reason: z.string().transform((reason) => (isPublishableCode(reason) ? reason : OTHER_REASON)),
	count: z.number().int().nonnegative(),
	retry_classification: z
		.string()
		.optional()
		.transform((code) => (code !== undefined && isPublishableCode(code) ? code : null)),
});

const declineSummarySchema = z.array(declineSchema).transform((declines) => {
	if (declines.length <= MAX_DECLINES) return declines;
	const rest = declines.slice(MAX_DECLINES - 1);
	const count = rest.reduce((sum, decline) => sum + decline.count, 0);
	return [
		...declines.slice(0, MAX_DECLINES - 1),
		{ reason: OTHER_REASON, count, retry_classification: null },
	];
});

/** `GET /v1/payments/quote-requests/{id}`. */
export const statusResponseSchema = z.object({
	quote_request_id: z.string().min(1),
	status: z.string(),
	quotes: z.array(quoteSchema).default([]),
	/** Absent means unknown, never zero. */
	requested_count: z.number().int().nonnegative().optional(),
	/** Absent means the gateway could not read the auction detail. */
	decline_summary: declineSummarySchema.optional(),
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;

const publicErrorSchema = z.object({
	code: z.string(),
	message: z.string(),
	retry_classification: z.string().optional(),
});

/** A 500 from the gateway's panic handler carries `{"error": "..."}` instead of a public error. */
const panicErrorSchema = z.object({ error: z.string() });

/** The code and message of an error body, which may be a public error, a panic, text, or nothing. */
export function describeError(body: unknown): { code: string | null; message: string } {
	const publicError = publicErrorSchema.safeParse(body);
	if (publicError.success)
		return { code: publicError.data.code, message: publicError.data.message };
	const panic = panicErrorSchema.safeParse(body);
	if (panic.success) return { code: null, message: panic.data.error };
	if (typeof body === "string" && body !== "") return { code: null, message: body.slice(0, 200) };
	return { code: null, message: "no error body" };
}

/** The first schema issue, for a `gateway_error` message. */
export function describeIssue(error: z.ZodError): string {
	const [issue] = error.issues;
	if (issue === undefined) return "response did not match the schema";
	const path = issue.path.join(".");
	return `${path === "" ? "response" : path}: ${issue.message}`;
}
