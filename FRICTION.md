# Friction log

Every doc gap, confusing field and surprise hit while building Corridor Weather, logged as it happened. Each item says what was expected, what happened, and what would have helped. For the Atum docs team.

Environment for all items: `@atumlabs/payment-gateway-client` 6.0.0, testnet gateway `https://payment-gw.production-testnet.atum.xyz`, 2026-11-22.

## 1. The SDK's HTTP layer does not run on Cloudflare Workers

- Expected: `client.prepareQuoteRequest(...)` works in a Worker with `nodejs_compat`. The package says `engines: node >= 18` and names no runtime limits.
- Happened: every call fails with `Failed to fetch defaults for chain eip155:421614: Unsupported cache mode: default`. The bundled axios picks its fetch adapter and passes a `cache` option that `workerd` rejects (wrangler 4.166.0, compatibility date 2026-11-01).
- Workaround: pass a custom `HttpRequest` class as the second constructor argument and send requests with `fetch`.
- Would help: a note on supported runtimes, or a fetch-based transport.

## 2. `prepareQuoteRequest` cannot build offline

- Expected: a `resolvedDefaults` parameter, as `preparePaymentRequest` and `prepareDirectDepositRequest` have.
- Happened: `prepareQuoteRequest` always fetches `/v1/defaults` twice, once per chain. A prober that already holds the full defaults listing pays two extra calls per quote.
- Workaround: the same custom `HttpRequest` class answers `/v1/defaults` from memory. `BaseHttpRequest` and `HttpRequestConstructor` are not exported, so the class is written against the structural type.
- Would help: `resolvedDefaults` on `prepareQuoteRequest`, and exported transport types.

## 3. `/v1/defaults` lists the Solana chain id in lower case

- Expected: the CAIP-2 id `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`. Base58 is case-sensitive.
- Happened: the listing keys the chain as `solana:etwtrabzayq6imfeykouru166vu2xqa1` and repeats that in `chain_id`. `GET /v1/defaults?chain_id=` echoes back whichever case the caller sends. The SDK's `parseAssetIdentifier` keeps the case it is given, so two spellings of one asset exist.
- Would help: one canonical spelling in every response, and a line in the chain defaults reference that says which.

## 4. Testnet defaults name a raw Cloud Run host for the verifier

- Expected: `https://veri-fill.production-testnet.atum.xyz`, which the Endpoints page calls the source of truth.
- Happened: every testnet chain returns `fulfillment_verifier.endpoint: https://veri-fill-382477456811.us-central1.run.app`.
- Would help: the documented hostname in the response, or a note that the two are the same service.

## 5. Rate-limit headers are undocumented and `x-ratelimit-reset` is always 0

- Expected: the rate limit and its window in the API reference. The brief asks what rate is acceptable.
- Happened: the docs name `RATE_LIMIT_EXCEEDED` (429) and nothing else. Responses carry `x-ratelimit-limit: 30`, `x-ratelimit-remaining` and `x-ratelimit-reset: 0`. The window had to be inferred: the remaining count recovered in under two seconds.
- Would help: the limit, the window, the scope (IP, account or route), and a real reset value.

## 6. No sanctioned way to mark synthetic traffic

- Expected: a metadata or tag field on a quote request, so operators can exclude probes from win-rate stats.
- Happened: no such field exists in the API reference or the SDK. Corridor Weather uses fixed keyless accounts, a `request_id` prefix and a `User-Agent`. Operators see only the first two.
- Would help: a documented field, or a documented convention.

## 7. An unserved corridor is declined as `INTERNAL`

- Expected: `UNSUPPORTED_DESTINATION_ASSET` (`NOT_RETRYABLE_FIX_REQUEST`) for a corridor no operator serves.
- Happened: Tron Shasta USDT to Solana devnet USDC, 1 USDC, drew one decline with reason `INTERNAL` and classification `RETRY_AFTER_DELAY`. A caller following that classification retries forever. This is one observation, and the cause inside the settler is unknown.
- Would help: a note on what `INTERNAL` covers in practice, or a more specific reason from the reference agent.

## 8. `requested_count` cannot say "nobody was asked"

- Expected: a way to tell "no operator is registered for this corridor" from "operators were asked and stayed silent".
- Happened: the reference says absent means unknown and never zero. It does not say what a broadcast to zero agents returns.
- Would help: one sentence on the zero case.

## 9. The sync wait cap has no stated value in the API reference

- Expected: the value of `quote_sync_wait_seconds`, since `wait=true` returns `collecting` when it fires first.
- Happened: the reference names the setting without a number. The quote guide says "up to 5 seconds".
- Would help: the number, or a field in `/v1/defaults`.

## 10. Quote request `status` values differ between pages

- Expected: one list.
- Happened: the quote guide lists `collecting`, `ready` and `expired`. The API reference adds `awarded`.
- Would help: the same list on both pages.
