# Corridor Weather design

Corridor Weather is an unofficial, open-source project. It is not an Atum product.

This document explains the design and answers the open questions in the
[project brief](https://corridor-weather-project-brief-aabk.pages.grok.bot/).
Read [RUNBOOK.md](./RUNBOOK.md) for deployment steps.

## What it does

A Cloudflare Worker runs on a cron schedule. Each run is a tick. A tick does five things.

1. It reads `GET /v1/defaults` and builds the corridor list from the chains and tokens the gateway returns.
2. It picks the next batch of probe targets. A probe target is one corridor at one amount tier.
3. It opens one quote request per target and polls the status endpoint until just after the quote deadline.
4. It stores every probe, with its raw HTTP exchanges, in D1.
5. On every `PUBLISH_EVERY_TICKS`th tick, it rebuilds the public snapshot and the alert list from the store.

The Worker also serves the dashboard and four read-only endpoints.

| Path                                  | Returns                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| `/`                                   | The static dashboard                                               |
| `/api/v1/snapshot.json`               | Current conditions for every corridor, written once per publish    |
| `/api/v1/corridors/{id}/history.json` | History for one corridor                                           |
| `/api/v1/health`                      | `200` when no alert is active, `503` with the alert list otherwise |
| `/metrics`                            | The same signals in Prometheus text format                         |

## Why it cannot move funds

The design removes the ability to spend. It does not rely on care.

- The gateway client has three operations: read defaults, create a quote request, and read a quote request. It refuses every other path before it sends anything, and it never follows a redirect. There is no award call.
- The quote request body has no `sender_auth` field. The builder's return type cannot hold one, and tests check the output.
- The probe accounts have no private key. Each address is derived from the hash of the public label `corridor-weather-probe/v1`, so no key for it exists. Run `pnpm run probe-identity` to reproduce the addresses.
- The Worker holds no secret that can sign or spend. Its bindings are one D1 database and the static assets. The one optional secret is the URL of the alert webhook.

## Shape

Two shapes were sketched.

|                  | Shape A: pure tick pipeline, one store     | Shape B: raw log in R2, views built on read     |
| ---------------- | ------------------------------------------ | ----------------------------------------------- |
| State owners     | D1 owns everything                         | R2 owns raw data, a second store owns views     |
| Public read cost | One row read per page view                 | Aggregation on every read, or a second pipeline |
| Recompute later  | Yes, raw exchanges are kept in `probe_raw` | Yes                                             |
| Moving parts     | 1 Worker, 1 D1                             | 1 Worker, R2, plus a view store                 |

Shape A is the choice. It keeps one owner for each piece of state and still keeps the raw responses. Moving `probe_raw` to R2 later is a storage change, not a redesign.

```
src/domain/    Pure logic. Corridors, amounts, schedule, spread, outcome, conditions, alerts, snapshot.
src/gateway/   The network boundary. Response schemas, the route-limited client, the SDK request builder.
src/store/     The D1 repository.
src/notify/   The alert webhook sender.
src/worker/    The shell. Config parsing, the scheduled handler, the read-only routes.
dashboard/     The static page. It imports the snapshot types from src/domain/snapshot.ts.
```

The dependency direction is one way. `domain` imports nothing. `gateway` and `store` import `domain`. `worker` wires them together.

### The Worker builds the request, the SDK checks it

The brief requires `@atumlabs/payment-gateway-client` 6.0.0 or later so that `quote_selector` is the depositor and not the gateway's own selector. Two ways to meet that were tried.

|                              | SDK inside the Worker                                                                                                | Wire format in the Worker, SDK in tests               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Worker bundle                | 680 KiB gzipped: the SDK brings axios, ethers and the Solana client                                                  | The prober's own code only                            |
| Runs on `workerd`            | Only with a hand-written transport, because the SDK's HTTP layer fails there ([FRICTION.md](../FRICTION.md), item 1) | Yes, plain `fetch`                                    |
| Couples to SDK internals     | Yes, to an unexported transport type                                                                                 | No                                                    |
| Who decides `quote_selector` | The SDK, at run time                                                                                                 | The prober, checked against the SDK on every test run |

The second is the choice. It is the pattern [tip-me-a-coffee](https://github.com/polds/tip-me-a-coffee) uses: the Worker speaks the wire format as pure functions over `fetch`, and the real SDK is the counterparty in tests.

- `src/gateway/quote-request.ts` builds the body. It is a pure function of the probe target, the defaults and the time.
- A conformance test builds the same request with the SDK's `prepareQuoteRequest` and requires the two bodies to be equal, for every pair of chain families. The test also fails if the installed SDK is older than 6.0.0.
- The builder refuses to produce a body whose `quote_selector` is the gateway's own selector.

A quote request body is a copy of fields from `/v1/defaults`, with one exception that the conformance test pins. For a Tron source, the SDK sends `quote_selector` and the verifier account as hex, not as base58 addresses.

The brief's rule is met in its purpose, which is a correct `quote_selector`, and not in its letter: the SDK does not run in production. A new SDK release that changes the body fails the conformance test when the dependency is updated.

### A probe is a small state machine

`create`, then `poll` on a fixed schedule that ends just after the quote deadline. [Platform limits](#platform-limits) gives the schedule. The result is one `ProbeOutcome` variant: `quoted`, `declined`, `silent`, `incomplete`, or `gateway_error`. See `src/domain/types.ts`. A probe never throws. Every failure becomes a `gateway_error` record, because a gateway failure is a measurement.

### Scheduling is stateless and idempotent

The target list is every corridor at every tier, sorted by id. Slot `n` probes `p` targets starting at offset `n * p` modulo the list length, where `p` is the number of probes the tick plans: `PROBES_PER_TICK`, or fewer under [Platform limits](#platform-limits). The slot index is `floor(now / interval)`. The interval is read from the probe cron, so the cron and the slot length cannot disagree. No cursor is stored.

The `request_id` of a probe is `cw1.{network}.{slotStart}.{corridorHash}.{tier}`. A retried cron run produces the same ids. The gateway then returns the original batch with `idempotent_replay: true` and does not broadcast to operators a second time.

The first write wins in the store. A retried run leaves the rows of the first run as they were, so a replay cannot overwrite a measurement. When the first run died before it stored anything, the retry stores the replayed batch without timings and without a price hold, because the retry did not measure them.

### Bounded inputs

The gateway is outside the trust boundary. `src/gateway/schemas.ts` and `src/gateway/client.ts` bound everything it sends before the rest of the code sees it.

- The client never follows a redirect. A 3xx answer is a failed call.
- The client reads at most 256 KiB of a response. A longer one is recorded as a failed call with no body.
- A response body is kept as the text the gateway sent. The Worker never serializes parsed gateway JSON again, so deep nesting cannot overflow the stack.
- One probe keeps at most 900 KiB of raw exchanges. Past that, the store cuts the response bodies between the first and the last exchange, then those two.
- A `quote_request_id` must match `[A-Za-z0-9._-]{1,128}`. A token symbol must match `[\w.-]{1,20}`. A token with any other symbol is dropped.
- A decline reason is published only when it is a code of at most 48 characters with no long run of hex digits. Any other reason is published as `OTHER`. A response keeps at most 50 decline entries.
- `GATEWAY_URL` must be the gateway of the configured network, or a loopback address for local runs. A testnet deployment cannot be pointed at mainnet by changing the URL.
- A `/v1/defaults` answer with no usable chain is a failed discovery. It aborts the tick and raises `gateway_errors`.
- A probe that throws is recorded as a `gateway_error`. It does not stop the tick.

The store splits the snapshot across rows, so its size does not depend on D1's 2 MB value limit.

### Platform limits

The Worker fits the limits of its plan by construction. It does not find them by failing. The first deploy, on the Workers Free plan, showed why: a tick of 30 probes made 8, then every later `fetch` threw, and 22 probes were stored as gateway errors that the gateway never caused.

| Limit                      | Workers Free | Workers Paid         | What the Worker does                                                                                         |
| -------------------------- | ------------ | -------------------- | ------------------------------------------------------------------------------------------------------------ |
| Subrequests per invocation | 50           | 10,000               | A probe has a fixed worst-case cost, and a tick never plans more probes than `SUBREQUEST_LIMIT` covers       |
| D1 rows written per day    | 100,000      | 50 million per month | A tick writes its probes. It rewrites the corridor list only when the list changes                           |
| D1 rows read per day       | 5 million    | 25 billion per month | Only a publish reads the store widely, and a publish runs on every `PUBLISH_EVERY_TICKS`th tick              |
| CPU time per invocation    | 10 ms        | 30 seconds           | Nothing yet. The CPU time of a tick on Cloudflare is not measured                                            |
| Cron Trigger duration      | 15 minutes   | 15 minutes           | `scheduled()` awaits its work. It does not lean on `waitUntil`, which ends 30 seconds after an HTTP response |

**A probe costs a fixed number of requests.** One create, then polls every `POLL_INTERVAL_MS` while the quote window is open, then one poll 500 ms after the quote deadline. The Worker knows the deadline, because it set it. With a 3 second window and a 500 ms interval that is 1 create and at most 6 polls: 7 requests, whatever the gateway does. A batch still `collecting` at that last poll is recorded as `incomplete`. The gateway closes a batch by its own clock, and the 500 ms covers the difference between the two clocks. In the three recorded testnet probes the batch was `ready` in a poll answered 213 to 246 ms after the deadline.

**A tick plans within its budget.** One request reads `/v1/defaults`, and 6 stay unused. The rest of `SUBREQUEST_LIMIT` is divided by the cost of a probe, and the tick probes that many targets or `PROBES_PER_TICK`, whichever is smaller. `SUBREQUEST_LIMIT` defaults to 50, the lowest limit of any plan, so the default configuration runs anywhere: 6 probes per tick, at most 43 requests. The 6 unused requests are a reserve. The plan counts the calls the Worker makes to the gateway, and nothing here has proved that Cloudflare counts only those, so a tick does not plan to end on the last request the limit allows. The rotation uses the planned number, so no target is skipped. When the budget is the smaller number, the tick logs `probes_capped`, and the snapshot reports the probes per tick it really runs.

**The corridor list is written when it changes.** The store keeps a hash of the discovered list. A tick whose list has the same hash writes no corridor row. Writing all 552 rows and their index on every tick was about 1,100 rows per tick, which alone passes the free daily limit at one tick every 10 minutes.

**A platform refusal is not a gateway error.** If `fetch` still reports that the subrequest limit was passed, the tick stops as `subrequest_limit`, stores nothing for the probe that hit it, and logs the tick as an error. The Worker recognizes the refusal by the word `subrequest` in the error text. On the deployed Worker the text was `Too many subrequests by single Worker invocation.` If Cloudflare changes it, the refused probes are stored as `gateway_error` with a null HTTP status, as before this change.

**Probing and publishing run at different rates.** The two free limits bind different things. The subrequest limit caps the probes in one tick, so more probes need more ticks. The D1 read limit caps how often the snapshot is rebuilt, because the rebuild reads the latest probe of every target. So the probe cron runs often, and a tick publishes only when its slot index is a multiple of `PUBLISH_EVERY_TICKS`. The rule needs no stored state. The publish interval is the tick interval times `PUBLISH_EVERY_TICKS`. The snapshot carries it as `publishIntervalMinutes`, and `prober_stale` and the dashboard's own staleness check count in publish intervals. `gateway_errors` judges the newest tick, which at a publish is the tick that publishes. A failing tick between two publishes raises nothing if the publishing tick is healthy. Its probes are still stored as `gateway_error` and show in the corridor history.

Measured in the test pool with the 552 testnet corridors, 3 tiers and 1,600 stored probes. Cloudflare's own accounting on a deployed database is not measured.

| Step                    | D1 rows read | D1 rows written  |
| ----------------------- | ------------ | ---------------- |
| A tick, without publish | 14           | 2, and 8 a probe |
| A publish               | 11,908       | 9                |

The committed configuration runs 6 probes every 2 minutes and publishes every 10 minutes. In a day that is 720 ticks, 4,320 probes and 144 publishes: about 1.7 million rows read, a third of the free limit, and about 46,000 rows written, under half of it. The written figure includes an estimate of 2 rows for each raw record that retention deletes.

Rows written set the ceiling of the free plan, at roughly 9,000 probes a day. Rows read do not grow with the probe rate. On the paid plan, set `SUBREQUEST_LIMIT` to `10000` and choose any `PROBES_PER_TICK`.

`/api/v1/health` returns `503` with `prober_stale` from a fresh deploy until the first publish, because health reads the newest tick from the snapshot. Expect one red check after the first deploy.

## Answers to the open questions

Answers marked "measured" come from three tagged testnet quote requests sent on 2026-11-22. Answers marked "needs a person" cannot be settled by code.

### 1. What probe rate is acceptable, and is there a rate limit?

Measured. Every gateway response carries `x-ratelimit-limit: 30`. The remaining count recovered within two seconds, so the limit is close to 30 requests per second per caller. One probe costs one `POST` and at most six `GET` calls over three and a half seconds. The gateway limit does not constrain a polite prober.

Needs a person. The limit that matters is the work each broadcast gives to settler operators, and nobody has agreed a number. The cadence is `PROBES_PER_TICK` sequential probes on each run of the probe cron, and `wrangler.jsonc` holds both. The repository owner sets it, and the dashboard shows the current value. Testnet has 552 corridors and 3 tiers, which is 1,656 targets. As a guide, the committed configuration runs 6 probes every 2 minutes, which fits the Workers Free plan: 180 broadcasts per hour, and one full sweep in about 9.2 hours. `PROBES_PER_TICK`, the cron schedule and `CORRIDOR_FILTER` change the rate. `PROBE_ENABLED=false` stops it.

**Decision needed before deploy.** Confirm the rate in `wrangler.jsonc` with whoever runs the settlers, or give a number.

### 2. Does the depositor need to be a funded or real account?

Measured, no. A keyless, unfunded address that has never transacted received a signed quote for 1 USDC from Arbitrum Sepolia to Base Sepolia at 2 bps. Any well-formed address works on testnet. The destination account must pass the gateway's payable-address check, so it cannot be the zero address.

### 3. Is there a sanctioned way to mark synthetic traffic?

No field for it exists in the API reference or the SDK. Corridor Weather marks its traffic three ways, and operators can filter on any of them.

| Marker                                       | Value                                                             |
| -------------------------------------------- | ----------------------------------------------------------------- |
| `source.account` and `destination[].account` | The keyless probe accounts listed in the README                   |
| `request_id` prefix                          | `cw1.`                                                            |
| `User-Agent`                                 | `corridor-weather/{version} (+{repository URL}; synthetic probe)` |

The account is the durable marker, because operators see the request body and not the HTTP headers. This is logged in FRICTION.md as a gap. A first-class field would be better.

### 4. Is publishing mainnet operator addresses and prices fine?

Needs a person, and legal. Until it is answered, the public snapshot carries no operator address. It carries the count of distinct operators and the best and worst price. Addresses stay in `probe_raw`. A decline reason that is not a plain code, or that holds a long run of hex digits, is published as `OTHER`. Mainnet also needs an explicit switch: the Worker refuses `NETWORK=mainnet` unless `MAINNET_ACK` is set to `cadence-and-publishing-agreed`.

### 5. What does an empty quotes list with an empty decline summary mean?

From the API reference, `requested_count - quotes - declines` is the number of operators that were asked and did not answer. So empty quotes with empty declines means every asked operator stayed silent, or, when `requested_count` is absent, that the gateway does not know how many it asked. The dashboard shows it as its own state, "silent", separate from "declined". An absent `requested_count` is shown as "unknown", never as zero.

### 6. Which amounts are representative without tripping liquidity declines on purpose?

Measured on one corridor. On Arbitrum Sepolia to Base Sepolia, 1, 25 and 100 USDC were each quoted at 2 bps. 250 USDC and 10,000 USDC were declined with `INSUFFICIENT_LIQUIDITY`. The testnet defaults are therefore 1, 25 and 100 whole tokens. They are configuration (`AMOUNT_TIERS`), given in whole tokens and converted with the decimals from `/v1/defaults`.

**Decision needed.** One corridor and one operator set these numbers. Operators know their testnet inventory and should confirm the large tier, or replace it.

## Conditions and alerts

A corridor's condition comes from the latest probe of each tier.

| Condition | Rule                                                  |
| --------- | ----------------------------------------------------- |
| Fair      | Every probed tier was quoted                          |
| Cloudy    | At least one tier was quoted and at least one was not |
| Stormy    | No tier was quoted                                    |
| Unknown   | Never probed                                          |

The condition does not rank operators and does not depend on who quoted.

| Alert            | Fires when                                                                                                | Severity |
| ---------------- | --------------------------------------------------------------------------------------------------------- | -------- |
| `prober_stale`   | The newest tick in the snapshot finished more than three publish intervals ago, or no tick has finished   | Critical |
| `gateway_errors` | Discovery failed or listed no usable chain, or half or more of a tick's probes were gateway errors        | Critical |
| `quotes_lost`    | A corridor was quoted in the last 7 days, and the latest probe of every configured tier is now not quoted | Critical |
| `slow_quotes`    | Time to first quote is above `SLOW_QUOTE_MS`                                                              | Warning  |

`quotes_lost` describes a state, not a moment. It stays active until a tier of the corridor is quoted again, or until 7 days pass with no quote. A corridor that still quotes at some tier raises no alert: the dashboard shows it as cloudy.

`/api/v1/health` returns `503` when a critical alert is active. An outside monitor only needs an HTTP check on that path. A deployment with no outside monitor uses the canary cron, described next. The public page shows alerts but pages nobody.

## Alert delivery

Two ways exist to learn that an alert fired. Use either, or both.

|                    | Pull                                                                        | Push                                                |
| ------------------ | --------------------------------------------------------------------------- | --------------------------------------------------- |
| Who starts it      | An outside monitor, such as a Datadog Synthetic test or a Prometheus scrape | A second Cloudflare Cron Trigger on the same Worker |
| What it reads      | `/api/v1/health` or `/metrics`                                              | The same health report, computed inside the Worker  |
| Needs              | A monitoring system                                                         | One webhook URL                                     |
| Sees a dead Worker | Yes                                                                         | No                                                  |

The push path exists for a deployment that has only Cloudflare.

The Worker has two Cron Triggers, and `scheduled()` tells them apart by `controller.cron`. `PROBE_CRON` and `CANARY_CRON` name the two expressions. A trigger whose expression matches neither does nothing and logs an error, so a mistyped variable can never turn the canary trigger into a second probe tick. The probe cron runs a tick. The canary cron, a few minutes after each publish, builds the health report that `/api/v1/health` serves and compares its alerts with the alerts it has already announced.

- An alert that is new is announced as raised.
- An alert that is gone from the health report is announced as cleared. Raising `ALERT_MIN_SEVERITY` does not clear an alert that is still active.
- An alert that is still active is not announced again.

One run sends at most one message, which lists what was raised and what was cleared. The text names at most ten alerts on each side. Past ten raised alerts it points at `/api/v1/health`, which lists every active alert. The canary records an announcement only after the webhook answers `2xx`, so a failed delivery is tried again on the next run. The announced alerts live in the `alert_notifications` table.

The canary is a separate invocation so that a tick that crashes or runs out of time cannot take the alert with it. A tick that stops finishing shows up as `prober_stale` on the next canary run.

Two limits are inherent, and no code inside the Worker can remove them.

- If Cloudflare stops invoking the Worker, nothing inside it can say so. Only an outside check on `/api/v1/health` sees that.
- A fresh deploy has no finished tick, so the first canary run can announce `prober_stale` and the next can clear it.

The webhook sender is not the gateway client. It posts JSON to the one configured URL, requires `https` (plain `http` only on a loopback address, for local runs), never follows a redirect, and sends nothing that names an operator. `ALERT_WEBHOOK_FORMAT` chooses between a `{"text": ...}` body, which Slack, Mattermost and Google Chat accept, and a structured body for anything else. With no `ALERT_WEBHOOK_URL`, the canary only logs.

## What is not built

- No routing advice and no price API that others should depend on. The JSON endpoints exist for the dashboard and can change.
- No operator ranking.
- No mainnet deployment. That waits for questions 1 and 4.
- No paging and no on-call routing. The Worker posts alert changes to one webhook. What that webhook does with them belongs to the team that owns it.
