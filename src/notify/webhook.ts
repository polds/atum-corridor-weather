import type { AlertMessage } from "../domain/notify";

/** `slack` posts `{"text": ...}`, which Slack, Mattermost and Google Chat accept. `json` posts the structured message. */
export type WebhookFormat = "slack" | "json";

export type DeliveryResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string };

export interface WebhookSender {
	/** The webhook's origin. The only part of the URL that may be logged. */
	readonly origin: string;
	/** Posts one message. Never throws. */
	send(message: AlertMessage): Promise<DeliveryResult>;
}

export interface WebhookSenderOptions {
	/** Secret. Never logged and never put in a result. */
	readonly url: string;
	readonly format: WebhookFormat;
	readonly userAgent: string;
	readonly fetch: typeof fetch;
	readonly timeoutMs: number;
}

/**
 * Posts alert messages to one URL. It is not the gateway client and shares none
 * of its routes: it sends only to the configured URL and never follows a redirect.
 */
export function createWebhookSender(options: WebhookSenderOptions): WebhookSender {
	return {
		origin: new URL(options.url).origin,
		async send(message) {
			const body = options.format === "slack" ? { text: message.text } : message.json;
			try {
				const response = await options.fetch(options.url, {
					method: "POST",
					headers: { "content-type": "application/json", "user-agent": options.userAgent },
					body: JSON.stringify(body),
					// A redirect would reach a URL nobody configured.
					redirect: "manual",
					signal: AbortSignal.timeout(options.timeoutMs),
				});
				// The answer's body is never read.
				await response.body?.cancel().catch(() => undefined);
				if (response.ok) return { ok: true };
				return {
					ok: false,
					reason:
						response.status >= 300 && response.status < 400
							? `HTTP ${response.status}: redirect not followed`
							: `HTTP ${response.status}`,
				};
			} catch (error) {
				// The error message can quote the URL, so only its name is kept.
				const name = error instanceof Error ? error.name : typeof error;
				return {
					ok: false,
					reason:
						name === "TimeoutError" || name === "AbortError" ? "timeout" : `transport: ${name}`,
				};
			}
		},
	};
}
