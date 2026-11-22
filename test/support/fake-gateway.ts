import type { ProbeFixture } from "./fixtures";

export interface SentRequest {
	readonly method: string;
	readonly url: URL;
	readonly headers: Headers;
	readonly body: unknown;
}

/** A clock that only moves when the test moves it. */
export class FakeClock {
	constructor(public ms: number) {}
	readonly now = (): number => this.ms;
	readonly sleep = async (ms: number): Promise<void> => {
		this.ms += ms;
	};
	advanceTo(ms: number): void {
		this.ms = Math.max(this.ms, ms);
	}
}

export function jsonResponse(
	status: number,
	json: unknown,
	headers: Readonly<Record<string, string>> = {},
): Response {
	return new Response(JSON.stringify(json), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

export type Handler = (request: SentRequest) => Response | Promise<Response>;

/** A `fetch` that records every request and answers from `handler`. */
export function scriptedFetch(handler: Handler): {
	readonly fetch: typeof fetch;
	readonly requests: SentRequest[];
} {
	const requests: SentRequest[] = [];
	const fake: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		const text = await request.text();
		const sent: SentRequest = {
			method: request.method,
			url: new URL(request.url),
			headers: request.headers,
			body: text === "" ? null : JSON.parse(text),
		};
		requests.push(sent);
		const signal = init?.signal;
		return new Promise<Response>((resolve, reject) => {
			signal?.addEventListener("abort", () => reject(signal.reason));
			Promise.resolve()
				.then(() => handler(sent))
				.then(resolve, reject);
		});
	};
	return { fetch: fake, requests };
}

/**
 * Answers the create call with `events[0]` and each poll with the next event,
 * repeating the last one. Moves the clock to the event's recorded time, counted
 * from the moment the create call was sent.
 */
export function replay(fixture: ProbeFixture, clock: FakeClock): Handler {
	let sentAt = clock.ms;
	let next = 0;
	return (request) => {
		if (request.method === "POST") {
			sentAt = clock.ms;
			next = 0;
		}
		const event = fixture.events[Math.min(next, fixture.events.length - 1)];
		next += 1;
		if (event === undefined) throw new Error("fixture has no events");
		clock.advanceTo(sentAt + event.t);
		return jsonResponse(event.status, event.json, event.headers);
	};
}

export type Scenario = (requestId: string) => ProbeFixture | Response;

/**
 * A gateway that serves `defaults` and answers each quote request from the
 * fixture `scenario` picks for its `request_id`. A repeated `request_id` gets
 * the same batch back with `idempotent_replay: true`, as the real gateway does.
 */
export function fakeGateway(params: {
	readonly clock: FakeClock;
	readonly defaults: () => Response;
	readonly scenario: Scenario;
}): Handler {
	const batches = new Map<string, { fixture: ProbeFixture; sentAt: number; next: number }>();
	const answer = (quoteRequestId: string, json: unknown, extra: object): unknown =>
		typeof json === "object" && json !== null
			? { ...json, quote_request_id: quoteRequestId, ...extra }
			: json;
	return (request) => {
		const { pathname } = request.url;
		if (pathname === "/v1/defaults") return params.defaults();
		if (request.method === "POST") {
			const requestId =
				typeof request.body === "object" && request.body !== null && "request_id" in request.body
					? String(request.body.request_id)
					: "";
			const quoteRequestId = `qr_${requestId}`;
			const replayed = batches.has(quoteRequestId);
			const chosen = params.scenario(requestId);
			if (chosen instanceof Response) return chosen;
			batches.set(quoteRequestId, { fixture: chosen, sentAt: params.clock.ms, next: 1 });
			const [created] = chosen.events;
			if (created === undefined) throw new Error("fixture has no create event");
			params.clock.advanceTo(params.clock.ms + created.t);
			return jsonResponse(
				created.status,
				answer(quoteRequestId, created.json, { idempotent_replay: replayed }),
			);
		}
		const quoteRequestId = decodeURIComponent(pathname.split("/").at(-1) ?? "");
		const batch = batches.get(quoteRequestId);
		if (batch === undefined) return jsonResponse(404, { code: "NOT_FOUND", message: "no batch" });
		const event = batch.fixture.events[Math.min(batch.next, batch.fixture.events.length - 1)];
		batch.next += 1;
		if (event === undefined) throw new Error("fixture has no events");
		params.clock.advanceTo(batch.sentAt + event.t);
		return jsonResponse(event.status, answer(quoteRequestId, event.json, {}));
	};
}
