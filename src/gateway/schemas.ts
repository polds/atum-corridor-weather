/**
 * Response schemas for the three gateway routes Corridor Weather calls. Unknown
 * fields are dropped, never rejected. Open string sets (`status`, decline
 * `reason`, `retry_classification`) stay strings.
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
	symbol: z.string().min(1),
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
	quote_request_id: z.string().min(1),
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

const declineSchema = z.object({
	reason: z.string(),
	count: z.number().int().nonnegative(),
	retry_classification: z.string().optional(),
});

/** `GET /v1/payments/quote-requests/{id}`. */
export const statusResponseSchema = z.object({
	quote_request_id: z.string().min(1),
	status: z.string(),
	quotes: z.array(quoteSchema).default([]),
	/** Absent means unknown, never zero. */
	requested_count: z.number().int().nonnegative().optional(),
	/** Absent means the gateway could not read the auction detail. */
	decline_summary: z.array(declineSchema).optional(),
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
