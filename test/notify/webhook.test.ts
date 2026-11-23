import { describe, expect, it } from "vitest";
import { renderMessage } from "../../src/domain/notify";
import { userAgent } from "../../src/gateway/client";
import { createWebhookSender, type WebhookFormat } from "../../src/notify/webhook";
import { type Handler, jsonResponse, scriptedFetch } from "../support/fake-gateway";
import { iso } from "../support/readings";

const URL_WITH_SECRET = "https://hooks.example.test/services/T000/B000/secret-token";
const USER_AGENT = userAgent("0.1.0", "https://github.com/example/corridor-weather");

const message = renderMessage({
	plan: {
		raised: [
			{
				kind: "prober_stale",
				severity: "critical",
				corridorId: null,
				message: "No tick has finished yet.",
				since: iso("2026-11-22T10:37:00.000Z"),
			},
		],
		cleared: [],
	},
	network: "testnet",
	generatedAt: iso("2026-11-22T10:37:00.000Z"),
	publicUrl: null,
});

function sender(handler: Handler, format: WebhookFormat = "slack", timeoutMs = 1000) {
	const fake = scriptedFetch(handler);
	return {
		webhook: createWebhookSender({
			url: URL_WITH_SECRET,
			format,
			userAgent: USER_AGENT,
			fetch: fake.fetch,
			timeoutMs,
		}),
		requests: fake.requests,
	};
}

describe("webhook sender", () => {
	it("posts a Slack-style text body to exactly the configured URL", async () => {
		const { webhook, requests } = sender(() => new Response("ok", { status: 200 }));
		expect(await webhook.send(message)).toStrictEqual({ ok: true });
		expect(requests).toHaveLength(1);
		const [request] = requests;
		expect(request?.method).toBe("POST");
		expect(request?.url.href).toBe(URL_WITH_SECRET);
		expect(request?.headers.get("content-type")).toBe("application/json");
		expect(request?.headers.get("user-agent")).toBe(USER_AGENT);
		expect(request?.body).toStrictEqual({ text: message.text });
		expect(webhook.origin).toBe("https://hooks.example.test");
	});

	it("posts the structured message in json format", async () => {
		const { webhook, requests } = sender(() => new Response(null, { status: 204 }), "json");
		expect(await webhook.send(message)).toStrictEqual({ ok: true });
		expect(requests[0]?.body).toStrictEqual(message.json);
	});

	it.each([
		[400, "HTTP 400"],
		[404, "HTTP 404"],
		[500, "HTTP 500"],
		[503, "HTTP 503"],
	])("reports %i as a failure", async (status, reason) => {
		const { webhook } = sender(() => jsonResponse(status, { error: "no" }));
		expect(await webhook.send(message)).toStrictEqual({ ok: false, reason });
	});

	it("does not follow a redirect and sends one request", async () => {
		const { webhook, requests } = sender(
			() => new Response(null, { status: 307, headers: { location: "https://elsewhere.test/" } }),
		);
		expect(await webhook.send(message)).toStrictEqual({
			ok: false,
			reason: "HTTP 307: redirect not followed",
		});
		expect(requests.map((request) => request.url.href)).toStrictEqual([URL_WITH_SECRET]);
	});

	it("reports a timeout as a failure", async () => {
		const { webhook } = sender(() => new Promise<Response>(() => {}), "slack", 20);
		expect(await webhook.send(message)).toStrictEqual({ ok: false, reason: "timeout" });
	});

	it("reports a thrown fetch without quoting the URL", async () => {
		const { webhook } = sender(() => {
			throw new TypeError(`cannot reach ${URL_WITH_SECRET}`);
		});
		const result = await webhook.send(message);
		expect(result).toStrictEqual({ ok: false, reason: "transport: TypeError" });
		expect(JSON.stringify(result)).not.toContain("secret-token");
	});

	it("never throws, even when fetch throws a non-error", async () => {
		const webhook = createWebhookSender({
			url: URL_WITH_SECRET,
			format: "slack",
			userAgent: USER_AGENT,
			fetch: () => Promise.reject("boom"),
			timeoutMs: 1000,
		});
		expect(await webhook.send(message)).toStrictEqual({ ok: false, reason: "transport: string" });
	});
});
