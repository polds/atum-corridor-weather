import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { isoAt } from "../../src/domain/brands";
import type { RawExchange } from "../../src/domain/types";
import { createStore } from "../../src/store/store";
import { clearTables } from "../support/db";
import { fixtures } from "../support/fixtures";
import { QUOTED, storeTick } from "../support/probes";
import { readRawExchanges } from "../support/raw";

const SLOT = "2026-11-22T10:00:00.000Z";

/** The recorded quoted probe as exchanges: one create, then polls, four of them the same answer. */
function recorded(pad = ""): RawExchange[] {
	return fixtures.quoted.events.map((event, index) => ({
		at: isoAt(Date.parse(SLOT) + event.t),
		method: index === 0 ? "POST" : "GET",
		path: index === 0 ? "/v1/payments/quote-requests" : "/v1/payments/quote-requests/qr",
		requestBody: index === 0 ? fixtures.quoted.body : null,
		status: event.status,
		latencyMs: 40,
		responseBody: index === 0 ? JSON.stringify(event.json) : `${JSON.stringify(event.json)}${pad}`,
		error: null,
	}));
}

function asRead(exchanges: readonly RawExchange[]) {
	return exchanges.map(({ method, path, status, responseBody }) => ({
		method,
		path,
		status,
		responseBody,
	}));
}

async function storedText(): Promise<string> {
	return String(await env.DB.prepare("SELECT raw_json FROM probe_raw").first("raw_json"));
}

beforeEach(clearTables);

describe("raw exchanges", () => {
	it("store a response body equal to the one before it once, and read back whole", async () => {
		const raw = recorded();
		const [probe] = await storeTick(createStore(env.DB), SLOT, [{ outcome: QUOTED, raw }]);
		const text = await storedText();
		const bodies = (JSON.parse(text) as { exchanges: { responseBody: unknown }[] }).exchanges.map(
			(exchange) => exchange.responseBody,
		);
		// Polls 2 to 5 repeat poll 1, so they point at it; the last poll differs.
		expect(bodies.slice(2, 6)).toStrictEqual(Array(4).fill({ sameAs: 1 }));
		expect(typeof bodies[6]).toBe("string");
		expect(text.length).toBeLessThan(
			JSON.stringify({ requestBody: null, exchanges: raw }).length / 2,
		);
		expect(await readRawExchanges(probe?.id ?? "")).toStrictEqual(asRead(raw));
	});

	it("read the same from a row stored before repeated bodies were stored once", async () => {
		const raw = recorded();
		await env.DB.prepare(
			"INSERT INTO probe_raw (probe_id, created_at, raw_json) VALUES (?1, ?2, ?3)",
		)
			.bind("old", SLOT, JSON.stringify({ requestBody: fixtures.quoted.body, exchanges: raw }))
			.run();
		expect(await readRawExchanges("old")).toStrictEqual(asRead(raw));
	});

	it("keep a repeated 240 KB poll answer whole, because it is stored once", async () => {
		// Six answers of 240 KB are over the 900 KiB budget; two distinct ones are not.
		const raw = recorded("x".repeat(240_000));
		const [probe] = await storeTick(createStore(env.DB), SLOT, [{ outcome: QUOTED, raw }]);
		expect(await storedText()).not.toContain('"truncated"');
		expect(await readRawExchanges(probe?.id ?? "")).toStrictEqual(asRead(raw));
	});
});
