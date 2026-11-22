# Corridor Weather design

Corridor Weather is an unofficial, open-source project. It is not an Atum product.

This document explains the design and answers the open questions in the
[project brief](https://corridor-weather-project-brief-aabk.pages.grok.bot/).
Read [RUNBOOK.md](./RUNBOOK.md) for deployment steps.

## What it does

A Cloudflare Worker runs on a cron schedule. Each run is a tick. A tick does five things.

1. It reads `GET /v1/defaults` and builds the corridor list from the chains and tokens the gateway returns.
2. It picks the next batch of probe targets. A probe target is one corridor at one amount tier.
3. It opens one quote request per target and polls the status endpoint until the quote window closes.
4. It stores every probe, with every raw HTTP exchange, in D1.
5. It rebuilds the public snapshot and the alert list from the store.

The Worker also serves the dashboard and four read-only endpoints.

| Path | Returns |
| --- | --- |
| `/` | The static dashboard |
| `/api/v1/snapshot.json` | Current conditions for every corridor, written once per tick |
| `/api/v1/corridors/{id}/history.json` | History for one corridor |
| `/api/v1/health` | `200` when no alert is active, `503` with the alert list otherwise |
| `/metrics` | The same signals in Prometheus text format |

## Why it cannot move funds

The design removes the ability to spend. It does not rely on care.

- The gateway client has three operations: read defaults, create a quote request, and read a quote request. It refuses every other path before it sends anything. There is no award call.
- The quote request body has no `sender_auth` field. The builder output is checked for it in tests.
- The probe accounts have no private key. Each address is derived from the hash of the public label `corridor-weather-probe/v1`, so no key for it exists. Run `pnpm run probe-identity` to reproduce the addresses.
- The Worker holds no secret. Its bindings are one D1 database and the static assets.

## Shape

Two shapes were sketched.

| | Shape A: pure tick pipeline, one store | Shape B: raw log in R2, views built on read |
| --- | --- | --- |
| State owners | D1 owns everything | R2 owns raw data, a second store owns views |
| Public read cost | One row read per page view | Aggregation on every read, or a second pipeline |
| Recompute later | Yes, raw exchanges are kept in `probe_raw` | Yes |
| Moving parts | 1 Worker, 1 D1 | 1 Worker, R2, plus a view store |

Shape A is the choice. It keeps one owner for each piece of state and still keeps every raw response. Moving `probe_raw` to R2 later is a storage change, not a redesign.

```
src/domain/    Pure logic. Corridors, amounts, schedule, spread, outcome, conditions, alerts, snapshot.
src/gateway/   The network boundary. Response schemas, the route-limited client, the SDK request builder.
src/store/     The D1 repository.
src/worker/    The shell. Config parsing, the scheduled handler, the read-only routes.
dashboard/     The static page. It imports the snapshot types from src/domain/snapshot.ts.
```

The dependency direction is one way. `domain` imports nothing. `gateway` and `store` import `domain`. `worker` wires them together.

### The SDK builds the request, the Worker sends it

The brief requires `@atumlabs/payment-gateway-client` 6.0.0 or later so that `quote_selector` is the depositor and not the gateway's own selector. The SDK's HTTP layer does not run on Cloudflare Workers ([FRICTION.md](../FRICTION.md), item 1). So the two jobs are split.

- `prepareQuoteRequest` from the SDK builds the body. The Worker gives the SDK a transport that answers `/v1/defaults` from the copy the tick already fetched. The SDK makes no network call.
- The Worker sends the body with `fetch`. It needs its own transport anyway, to time each call, keep the raw response, set a `User-Agent`, and read rate-limit headers.

This was proven in a throwaway Worker before the design was fixed. The SDK builds a body in about 5 ms under `workerd`. The bundle is 680 KiB gzipped.

### A probe is a small state machine

`create` then `poll` until the batch leaves `collecting` or the poll budget ends. The result is one `ProbeOutcome` variant: `quoted`, `declined`, `silent`, `incomplete`, or `gateway_error`. See `src/domain/types.ts`. A probe never throws. Every failure becomes a `gateway_error` record, because a gateway failure is a measurement.

### Scheduling is stateless and idempotent

The target list is every corridor at every tier, sorted by id. Slot `n` probes `PROBES_PER_TICK` targets starting at offset `n * PROBES_PER_TICK` modulo the list length. The slot index is `floor(now / interval)`. No cursor is stored.

The `request_id` of a probe is `cw1.{network}.{slotStart}.{corridorHash}.{tier}`. A retried cron run produces the same ids. The gateway then returns the original batch with `idempotent_replay: true` and does not broadcast to operators a second time. Store writes are upserts keyed by the same id.

## Answers to the open questions

Answers marked "measured" come from three tagged testnet quote requests sent on 2026-11-22. Answers marked "needs a person" cannot be settled by code.

### 1. What probe rate is acceptable, and is there a rate limit?

Measured. Every gateway response carries `x-ratelimit-limit: 30`. The remaining count recovered within two seconds, so the limit is close to 30 requests per second per caller. One probe costs one `POST` and about seven `GET` calls over three seconds. The gateway limit does not constrain a polite prober.

Needs a person. The limit that matters is the work each broadcast gives to settler operators, and nobody has agreed a number. The default is deliberately low: 30 sequential probes every 5 minutes, which is 360 broadcasts per hour. Testnet has 552 corridors and 3 tiers, so one full sweep takes about 4.6 hours. `PROBES_PER_TICK`, the cron schedule and `CORRIDOR_FILTER` change the rate. `PROBE_ENABLED=false` stops it.

**Decision needed before deploy.** Confirm 360 broadcasts per hour on testnet with whoever runs the settlers, or give a number.

### 2. Does the depositor need to be a funded or real account?

Measured, no. A keyless, unfunded address that has never transacted received a signed quote for 1 USDC from Arbitrum Sepolia to Base Sepolia at 2 bps. Any well-formed address works on testnet. The destination account must pass the gateway's payable-address check, so it cannot be the zero address.

### 3. Is there a sanctioned way to mark synthetic traffic?

No field for it exists in the API reference or the SDK. Corridor Weather marks its traffic three ways, and operators can filter on any of them.

| Marker | Value |
| --- | --- |
| `source.account` and `destination[].account` | The keyless probe accounts listed in the README |
| `request_id` prefix | `cw1.` |
| `User-Agent` | `corridor-weather/{version} (+{repository URL}; synthetic probe)` |

The account is the durable marker, because operators see the request body and not the HTTP headers. This is logged in FRICTION.md as a gap. A first-class field would be better.

### 4. Is publishing mainnet operator addresses and prices fine?

Needs a person, and legal. Until it is answered, the public snapshot carries no operator address. It carries the count of distinct operators and the best and worst price. Addresses stay in `probe_raw`. Mainnet also needs an explicit switch: the Worker refuses `NETWORK=mainnet` unless `MAINNET_ACK` is set to `cadence-and-publishing-agreed`.

### 5. What does an empty quotes list with an empty decline summary mean?

From the API reference, `requested_count - quotes - declines` is the number of operators that were asked and did not answer. So empty quotes with empty declines means every asked operator stayed silent, or, when `requested_count` is absent, that the gateway does not know how many it asked. The dashboard shows it as its own state, "silent", separate from "declined". An absent `requested_count` is shown as "unknown", never as zero.

### 6. Which amounts are representative without tripping liquidity declines on purpose?

Measured, partly. On Arbitrum Sepolia to Base Sepolia, 1 USDC was quoted and 10,000 USDC was declined with `INSUFFICIENT_LIQUIDITY`. The testnet defaults are therefore 1, 25 and 250 whole tokens. They are configuration (`AMOUNT_TIERS`), given in whole tokens and converted with the decimals from `/v1/defaults`.

**Decision needed.** The large tier is a guess between the two measured points. Operators know their testnet inventory and should set it.

## Conditions and alerts

A corridor's condition comes from the latest probe of each tier.

| Condition | Rule |
| --- | --- |
| Fair | Every probed tier was quoted |
| Cloudy | At least one tier was quoted and at least one was not |
| Stormy | No tier was quoted |
| Unknown | Never probed |

The condition does not rank operators and does not depend on who quoted.

| Alert | Fires when | Severity |
| --- | --- | --- |
| `prober_stale` | No tick finished within three intervals | Critical |
| `gateway_errors` | Discovery failed, or half or more of a tick's probes were gateway errors | Critical |
| `quotes_lost` | A corridor tier was quoted on its previous probe and is not quoted now | Critical |
| `slow_quotes` | Time to first quote is above `SLOW_QUOTE_MS` | Warning |

`/api/v1/health` returns `503` when a critical alert is active. A monitor only needs an HTTP check on that path. The public page shows alerts but pages nobody.

## What is not built

- No routing advice and no price API that others should depend on. The JSON endpoints exist for the dashboard and can change.
- No operator ranking.
- No mainnet deployment. That waits for questions 1 and 4.
- No alert delivery. The team's monitoring owns that. RUNBOOK.md has the check to add and the drill that proves it fires.
