import type { z } from "zod";
import { isoAt } from "../domain/brands";
import type { DefaultsListing } from "../domain/corridors";
import type { RawExchange } from "../domain/types";
import type { QuoteRequestBody } from "./quote-request";
import {
	type CreateResponse,
	createResponseSchema,
	defaultsListingSchema,
	describeError,
	describeIssue,
	type StatusResponse,
	statusResponseSchema,
} from "./schemas";

export type GatewayMethod = "GET" | "POST";

/**
 * The only routes the client sends. Award and payment routes are absent on
 * purpose: Corridor Weather can open a quote request and read it, nothing more.
 */
const ALLOWED_ROUTES: readonly { readonly method: GatewayMethod; readonly path: RegExp }[] = [
	{ method: "GET", path: /^\/v1\/defaults$/ },
	{ method: "POST", path: /^\/v1\/payments\/quote-requests$/ },
	{ method: "GET", path: /^\/v1\/payments\/quote-requests\/[A-Za-z0-9._-]{1,128}$/ },
];

/** The largest response body the client reads. A poll answer is a few KiB. */
const MAX_RESPONSE_BYTES = 256 * 1024;

export type GatewayFailure =
	| { readonly kind: "refused"; readonly message: string }
	| { readonly kind: "transport"; readonly message: string }
	| { readonly kind: "timeout"; readonly message: string }
	| {
			readonly kind: "http";
			readonly status: number;
			readonly code: string | null;
			readonly message: string;
	  }
	| { readonly kind: "invalid_response"; readonly status: number; readonly message: string };

export type GatewayResult<T> =
	| { readonly ok: true; readonly value: T; readonly exchange: RawExchange }
	| { readonly ok: false; readonly failure: GatewayFailure; readonly exchange: RawExchange };

export interface GatewayRequest {
	readonly method: GatewayMethod;
	readonly path: string;
	readonly query?: Readonly<Record<string, string>>;
	readonly body?: object;
}

export interface GatewayClient {
	/** Sends one request if its route is allowed. Never throws. */
	send(request: GatewayRequest): Promise<GatewayResult<unknown>>;
	getDefaults(): Promise<GatewayResult<DefaultsListing>>;
	createQuoteRequest(body: QuoteRequestBody): Promise<GatewayResult<CreateResponse>>;
	getQuoteRequest(quoteRequestId: string): Promise<GatewayResult<StatusResponse>>;
}

export interface GatewayClientOptions {
	readonly baseUrl: string;
	readonly userAgent: string;
	readonly fetch: typeof fetch;
	/** Epoch ms. */
	readonly now: () => number;
	readonly timeoutMs: number;
}

export function userAgent(version: string, repositoryUrl: string): string {
	return `corridor-weather/${version} (+${repositoryUrl}; synthetic probe)`;
}

/** Why a request may not be sent, or null when its route is on the allowlist. */
function refusal(request: GatewayRequest, url: URL, baseUrl: string): string | null {
	if (request.body !== undefined && "sender_auth" in request.body) {
		return "a request body with sender_auth";
	}
	const allowed =
		url.origin === new URL(baseUrl).origin &&
		ALLOWED_ROUTES.some(
			(route) => route.method === request.method && route.path.test(url.pathname),
		);
	return allowed ? null : `${request.method} ${url.origin}${url.pathname}`;
}

/** The body as text, or null when it is longer than `MAX_RESPONSE_BYTES`. Stops reading at the cap. */
async function readCapped(response: Response): Promise<string | null> {
	if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
		await response.body?.cancel();
		return null;
	}
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return text + decoder.decode();
		bytes += value.byteLength;
		if (bytes > MAX_RESPONSE_BYTES) {
			await reader.cancel();
			return null;
		}
		text += decoder.decode(value, { stream: true });
	}
}

function parseBody(text: string): unknown {
	if (text === "") return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function isRedirect(status: number): boolean {
	return status >= 300 && status < 400;
}

function isTimeout(error: unknown): boolean {
	return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

export function createGatewayClient(options: GatewayClientOptions): GatewayClient {
	async function send(request: GatewayRequest): Promise<GatewayResult<unknown>> {
		const startedMs = options.now();
		const url = new URL(request.path, options.baseUrl);
		for (const [key, value] of Object.entries(request.query ?? {})) {
			url.searchParams.set(key, value);
		}
		const base: Omit<RawExchange, "status" | "latencyMs" | "responseBody" | "error"> = {
			at: isoAt(startedMs),
			method: request.method,
			path: `${url.pathname}${url.search}`,
			requestBody: request.body ?? null,
		};
		const refused = refusal(request, url, options.baseUrl);
		if (refused !== null) {
			const message = `refused before sending: ${refused}`;
			return {
				ok: false,
				failure: { kind: "refused", message },
				exchange: { ...base, status: null, latencyMs: 0, responseBody: null, error: message },
			};
		}
		let status: number | null = null;
		try {
			const response = await options.fetch(url.toString(), {
				method: request.method,
				headers: {
					accept: "application/json",
					"user-agent": options.userAgent,
					...(request.body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
				// A redirect would reach a URL the allowlist never checked.
				redirect: "manual",
				signal: AbortSignal.timeout(options.timeoutMs),
			});
			status = response.status;
			const text = await readCapped(response);
			if (text === null) {
				const message = `response too large: over ${MAX_RESPONSE_BYTES} bytes, not kept`;
				return {
					ok: false,
					failure: { kind: "invalid_response", status, message },
					exchange: {
						...base,
						status,
						latencyMs: options.now() - startedMs,
						responseBody: null,
						error: message,
					},
				};
			}
			const responseBody = parseBody(text);
			const exchange: RawExchange = {
				...base,
				status,
				latencyMs: options.now() - startedMs,
				responseBody,
				error: null,
			};
			if (response.ok) return { ok: true, value: responseBody, exchange };
			const { code, message } = isRedirect(status)
				? { code: null, message: `redirect to ${response.headers.get("location")} not followed` }
				: describeError(responseBody);
			return { ok: false, failure: { kind: "http", status, code, message }, exchange };
		} catch (error) {
			const message = errorText(error);
			const kind = isTimeout(error) ? "timeout" : "transport";
			return {
				ok: false,
				failure: { kind, message },
				exchange: {
					...base,
					status,
					latencyMs: options.now() - startedMs,
					responseBody: null,
					error: message,
				},
			};
		}
	}

	async function sendParsed<T>(
		request: GatewayRequest,
		schema: z.ZodType<T, z.ZodTypeDef, unknown>,
	): Promise<GatewayResult<T>> {
		const result = await send(request);
		if (!result.ok) return result;
		const parsed = schema.safeParse(result.value);
		if (parsed.success) return { ok: true, value: parsed.data, exchange: result.exchange };
		const message = `unexpected response: ${describeIssue(parsed.error)}`;
		return {
			ok: false,
			failure: { kind: "invalid_response", status: result.exchange.status ?? 0, message },
			exchange: { ...result.exchange, error: message },
		};
	}

	return {
		send,
		getDefaults: () => sendParsed({ method: "GET", path: "/v1/defaults" }, defaultsListingSchema),
		createQuoteRequest: (body) =>
			sendParsed(
				{
					method: "POST",
					path: "/v1/payments/quote-requests",
					query: { wait: "false" },
					body,
				},
				createResponseSchema,
			),
		getQuoteRequest: (quoteRequestId) =>
			sendParsed(
				{
					method: "GET",
					path: `/v1/payments/quote-requests/${encodeURIComponent(quoteRequestId)}`,
				},
				statusResponseSchema,
			),
	};
}
