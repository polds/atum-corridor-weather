# Corridor Weather

[![CI](https://github.com/polds/atum-corridor-weather/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/polds/atum-corridor-weather/actions/workflows/ci.yml)

Corridor Weather sends small, tagged quote requests to the Atum testnet payment gateway on a schedule and records whether settlement operators quote, decline, or stay silent on each corridor. It publishes the results as a public dashboard and read-only JSON.

> [!IMPORTANT]
> Corridor Weather is an unofficial, community project. It is **not an official Atum product** and Atum does not endorse it. It comes with no warranty of any kind (see [LICENSE](LICENSE)). Prices on the dashboard are indicative readings of past quotes. They are not offers.

## It cannot move funds

The design removes the ability to spend, for four structural reasons. [docs/DESIGN.md](docs/DESIGN.md#why-it-cannot-move-funds) has the details.

- The gateway client has three operations: read defaults, create a quote request, and read a quote request. It refuses every other path before it sends anything, and it never follows a redirect. There is no award call.
- The quote request body has no `sender_auth` field. Tests check the builder output for it.
- The probe accounts have no private key. Each address comes from the hash of the public label `corridor-weather-probe/v1`, so no key for it exists.
- The Worker holds no secret that can sign or spend. Its only bindings are one D1 database and the static assets. The one optional secret is the URL of the alert webhook.

## What a probe is

A corridor is a source token on one chain and a destination token on another. A probe target is one corridor at one amount tier. A Cloudflare Worker runs on a cron schedule, and each run is a tick. Each tick does five things.

1. It reads `GET /v1/defaults` and builds the corridor list from the chains and tokens that the gateway returns.
2. It picks the next batch of probe targets.
3. It opens one quote request per target and polls its status until just after the quote deadline.
4. It stores every probe in D1, with its raw HTTP exchanges.
5. On every `PUBLISH_EVERY_TICKS`th tick, it rebuilds the public snapshot and the alert list from the store.

Each probe ends in one outcome: `quoted`, `declined`, `silent`, `incomplete`, or `gateway_error`. The store keeps the quotes, the decline reasons, the timings, and the raw responses. A decline reason that is not a plain code is kept as `OTHER`. The public snapshot shows the number of distinct operators and the best and worst price. It does not show operator addresses.

## Probe traffic, for settlement operators

Corridor Weather marks every request in three ways. Filter on any of them, for example to keep probes out of win-rate statistics.

| Marker                                       | Value                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `source.account` and `destination[].account` | One keyless account per chain namespace, listed below                                           |
| `request_id` prefix                          | `cw1.` The full form is `cw1.{network}.{slotStart}.{corridorHash}.{tier}`.                      |
| `User-Agent` header                          | `corridor-weather/{version} (+https://github.com/polds/atum-corridor-weather; synthetic probe)` |

| Namespace | Probe account                                  |
| --------- | ---------------------------------------------- |
| `eip155`  | `0xD5C4D0bbcC3f01886cb1E8E29BB348776892270F`   |
| `tron`    | `TVTWhtawdkwzezxjU4qi7k4FDqFtn7X5N1`           |
| `solana`  | `5YdDoh63Jeu5WMMwxfwYS5uHE5Sru6M8BcUech2G671N` |

Operators see the request body but not the HTTP headers, so the account is the marker to rely on. Run `pnpm run probe-identity` to derive the accounts yourself.

The cadence is set in `wrangler.jsonc`: up to `PROBES_PER_TICK` probes on each run of `PROBE_CRON`. On the Workers Free plan a tick runs 6, because one run may make only 50 requests. A tick rebuilds the dashboard's snapshot only on every `PUBLISH_EVERY_TICKS`th tick, so the dashboard and the alerts change once per publish, not once per tick. The dashboard states the current cadence and how long one sweep of every corridor takes. Nobody has agreed a rate with the settler operators yet. A retried cron run reuses the same `request_id` values, so the gateway does not broadcast the same probe twice.

To ask for a lower rate, or for probing to stop, [open an issue](https://github.com/polds/atum-corridor-weather/issues/new). The maintainer can lower `PROBES_PER_TICK` or set `PROBE_ENABLED=false` and redeploy. [docs/RUNBOOK.md](docs/RUNBOOK.md#change-the-probe-rate) has the steps.

## Quick start

You need Node 22 (see `.nvmrc`) and pnpm 10. Run `corepack enable pnpm` to use the pnpm version that `package.json` names.

1. Install the dependencies.

   ```bash
   pnpm install
   ```

2. Run lint, typecheck, tests, and the build.

   ```bash
   pnpm run check
   ```

3. Create the tables in the local D1 database.

   ```bash
   pnpm run db:migrate:local
   ```

4. If you want to run the Worker without sending quote requests, create a `.dev.vars` file that contains `PROBE_ENABLED=false`. Otherwise every tick sends real quote requests to the testnet gateway, from the probe accounts above. `pnpm run dev` sets `PUBLISH_EVERY_TICKS=1`, so every local tick publishes the snapshot. A deployed tick publishes only on a publish slot.

5. Start the Worker on `http://localhost:8787` with a local D1 database.

   ```bash
   pnpm run dev
   ```

6. In a second terminal, trigger one tick.

   ```bash
   pnpm run tick
   ```

   `pnpm run canary` and `pnpm run maintenance` fire the other two crons the same way.

7. Open `http://localhost:8787/` for the dashboard, or read `http://localhost:8787/api/v1/snapshot.json`.

## Configuration

The variables and their current values are in the `vars` block of `wrangler.jsonc`. A deploy replaces any value set in the Cloudflare dashboard with the value in `wrangler.jsonc`.

| Variable               | Meaning                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NETWORK`              | The network to probe. `mainnet` is refused unless `MAINNET_ACK` is set.                                                                                                                                                                                                                                                                                                                        |
| `GATEWAY_URL`          | The origin of the Atum payment gateway. It must be the gateway of `NETWORK`, or a loopback address for local runs.                                                                                                                                                                                                                                                                             |
| `PROBE_ENABLED`        | `false` stops probing.                                                                                                                                                                                                                                                                                                                                                                         |
| `PROBES_PER_TICK`      | The most probe targets in each tick. A tick runs fewer when `SUBREQUEST_LIMIT` does not cover them.                                                                                                                                                                                                                                                                                            |
| `SUBREQUEST_LIMIT`     | The subrequests one invocation may make on your Cloudflare plan: `50` on Workers Free, `10000` on Workers Paid. A tick plans its probes to fit, with 6 requests left unused. With `50` and the timing below, a tick runs 6 probes.                                                                                                                                                             |
| `PUBLISH_EVERY_TICKS`  | A tick rebuilds the snapshot and the alerts when its slot index is a multiple of this value, so the publish interval is the tick interval times this value. A rebuild reads the latest probe of every target, so publishing less often keeps D1 rows read within the Workers Free limit. `1` to `60`. Unset, every tick publishes.                                                             |
| `AMOUNT_TIERS`         | The amount for each tier, in whole tokens. The Worker converts it with the decimals from `/v1/defaults`. At most 18 fractional and 24 integer digits.                                                                                                                                                                                                                                          |
| `POLL_INTERVAL_MS`     | The wait between two status polls of one quote request. A shorter wait means more requests for each probe.                                                                                                                                                                                                                                                                                     |
| `QUOTE_WINDOW_SECONDS` | The quote window a probe asks for. The probe polls until 500 ms after it closes, then records the result.                                                                                                                                                                                                                                                                                      |
| `SLOW_QUOTE_MS`        | The `slow_quotes` alert fires when the time to the first quote is above this value.                                                                                                                                                                                                                                                                                                            |
| `CORRIDOR_FILTER`      | Empty probes every corridor. Otherwise a regular expression. The Worker probes only the corridors whose label matches it. A label is `{source chain id}/{symbol}>{destination chain id}/{symbol}`, for example `eip155:421614/USDC>eip155:84532/USDC`.                                                                                                                                         |
| `MAINNET_ACK`          | Must be `cadence-and-publishing-agreed` before the Worker accepts `NETWORK=mainnet`.                                                                                                                                                                                                                                                                                                           |
| `REPOSITORY_URL`       | The URL in the probe `User-Agent`. The deploy workflow replaces it with the URL of the repository that deploys, so a fork names itself.                                                                                                                                                                                                                                                        |
| `PROBE_CRON`           | The cron expression that runs a probe tick. It sets the cadence: the tick interval is read from it, so it must fire at one fixed interval, such as `*/10 * * * *`, `0 * * * *` or `0 */6 * * *`. It must equal one entry in `triggers.crons`, character for character. A trigger that matches none of `PROBE_CRON`, `CANARY_CRON` and `MAINTENANCE_CRON` does nothing and logs `unknown_cron`. |
| `CANARY_CRON`          | The cron expression that runs the canary. Run it a few minutes after each publish, so that it reads a fresh snapshot. It must equal one entry in `triggers.crons`, character for character.                                                                                                                                                                                                    |
| `MAINTENANCE_CRON`     | The cron expression of the daily maintenance run. It writes the daily figures of finished days and deletes at most one expired day of each kind of data. Run it once a day, at a minute when no tick, publish or canary runs. It must equal one entry in `triggers.crons`, character for character.                                                                                            |
| `RAW_RETENTION_DAYS`   | The days, besides today, that the raw HTTP exchanges of each probe are kept. At least 1, and not above `PROBE_RETENTION_DAYS`. Raw exchanges are most of the database.                                                                                                                                                                                                                         |
| `PROBE_RETENTION_DAYS` | The days, besides today, that probes, their decline reasons and ticks are kept. At least 8, because the `quotes_lost` alert looks back 7 days. It is also the most `days` the history endpoint accepts.                                                                                                                                                                                        |
| `DAILY_RETENTION_DAYS` | The days, besides today, that the daily figures of each corridor tier are kept. Not below `PROBE_RETENTION_DAYS`.                                                                                                                                                                                                                                                                              |
| `ALERT_WEBHOOK_URL`    | A secret, set with `wrangler secret put`. The canary posts alert changes to it. It must use `https`. Unset, the canary only logs.                                                                                                                                                                                                                                                              |
| `ALERT_WEBHOOK_FORMAT` | `slack` posts `{"text": ...}`, which Slack, Mattermost and Google Chat accept. `json` posts a structured body.                                                                                                                                                                                                                                                                                 |
| `ALERT_MIN_SEVERITY`   | `critical` announces critical alerts only. `warning` also announces `slow_quotes`.                                                                                                                                                                                                                                                                                                             |
| `PUBLIC_URL`           | The address of the deployed Worker. When set, alert messages end with links to the dashboard and the health report.                                                                                                                                                                                                                                                                            |

## HTTP endpoints

| Path                                  | Returns                                                                                                                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                   | The static dashboard                                                                                                                                                                                      |
| `/api/v1/snapshot.json`               | Current conditions for every corridor, written once per publish                                                                                                                                           |
| `/api/v1/corridors/{id}/history.json` | History for one corridor: every probe of the last `days` days (7 unless set, at most `PROBE_RETENTION_DAYS`) in `points`, and one entry per day and tier for up to `DAILY_RETENTION_DAYS` days in `daily` |
| `/api/v1/health`                      | `200` when no critical alert is active, `503` with the alert list otherwise                                                                                                                               |
| `/metrics`                            | The same signals in Prometheus text format                                                                                                                                                                |

The JSON endpoints exist for the dashboard. They can change without notice, so do not build on them.

## Project status

- Testnet only. The deploy workflow refuses a `wrangler.jsonc` that sets `NETWORK` to anything but `testnet`.
- Not deployed yet. `wrangler.jsonc` still holds a placeholder D1 database id.
- Two decisions need a person before the project goes further. [docs/DESIGN.md](docs/DESIGN.md#answers-to-the-open-questions) explains both.
  - Question 1: agree a probe rate on testnet with the settler operators. This blocks the first deploy.
  - Question 4: decide whether publishing mainnet operator addresses and prices is acceptable. This needs legal review and blocks mainnet.

## Documentation

- [docs/DESIGN.md](docs/DESIGN.md) explains the design, the safety rules, and the answers to the open questions.
- [docs/RUNBOOK.md](docs/RUNBOOK.md) has the steps to deploy, change the probe rate, wire up monitoring, and read raw data.
- [FRICTION.md](FRICTION.md) logs every gap found in the Atum docs and API.
- [CONTRIBUTING.md](CONTRIBUTING.md) explains how to set up, test, and send a change.
- [SECURITY.md](SECURITY.md) explains how to report a vulnerability.

## License

Apache License 2.0. See [LICENSE](LICENSE).
