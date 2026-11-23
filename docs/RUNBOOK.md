# Corridor Weather runbook

These guides operate the testnet deployment of Corridor Weather. Corridor Weather is an unofficial, community project and not an Atum product. [DESIGN.md](./DESIGN.md) explains why the system works the way it does.

Every guide assumes a checkout of `main`, Node 22, pnpm 10, and `pnpm install`. Commands that change Cloudflare need `pnpm exec wrangler login` first. Commands that change GitHub need `gh auth login` first.

In the commands below, `WORKER_URL` is the URL that `wrangler deploy` prints, for example `https://corridor-weather.<your-subdomain>.workers.dev`.

```bash
export WORKER_URL="https://corridor-weather.<your-subdomain>.workers.dev"
```

## First deploy

Do not deploy before DESIGN.md question 1 has an answer. Each tick broadcasts up to `PROBES_PER_TICK` quote requests to the settler operators.

1. Log in to Cloudflare.

   ```bash
   pnpm exec wrangler login
   ```

2. Create the D1 database.

   ```bash
   pnpm exec wrangler d1 create corridor-weather
   ```

3. Keep the `database_id` that the command prints. Do not put it in `wrangler.jsonc`. The committed file holds a placeholder, so a fork of this repository never carries your database.

4. Save the id as a repository variable named `D1_DATABASE_ID`. It is an identifier, not a credential, so it is a variable and not a secret.

   ```bash
   gh variable set D1_DATABASE_ID --body "<the database_id>"
   ```

5. Deploy from your machine. The command builds the dashboard, writes `wrangler.deploy.jsonc` with your id, checks that the config is testnet, creates the tables and deploys. Wrangler prints the Worker URL. Save it as `WORKER_URL`.

   ```bash
   D1_DATABASE_ID="<the database_id>" pnpm run deploy
   ```

   `wrangler.deploy.jsonc` is ignored by git. Do not commit it.

6. Wait for the first publish, up to one publish interval: the tick interval times `PUBLISH_EVERY_TICKS`. Ticks before it store probes, but the dashboard and `/api/v1/snapshot.json` stay empty until a tick on a publish slot runs, and the health endpoint returns `503` with `prober_stale` until then. Then check the health endpoint.

   ```bash
   curl -i "$WORKER_URL/api/v1/health"
   ```

7. Check that no real id is staged. The id in `wrangler.jsonc` must still be `00000000-0000-0000-0000-000000000000`. A test fails if it is not.

8. Create the `testnet` environment on GitHub.

   ```bash
   gh api --method PUT 'repos/{owner}/{repo}/environments/testnet'
   ```

9. Create a Cloudflare API token that can edit Workers scripts and D1 databases in your account.

10. Print your Cloudflare account id.

    ```bash
    pnpm exec wrangler whoami
    ```

11. Save the token and the account id as secrets of the `testnet` environment. Each command asks for the value.

    ```bash
    gh secret set CLOUDFLARE_API_TOKEN --env testnet
    gh secret set CLOUDFLARE_ACCOUNT_ID --env testnet
    ```

12. In the branch protection rule for `main`, require the `ci-ok` status check. It passes only when every CI job passes.

13. Run the deploy workflow once to check the secrets and the variable.

    ```bash
    gh workflow run deploy.yml --ref main
    gh run watch
    ```

From then on, the **Deploy** workflow runs after every **CI** run that passes on a push to `main`. It deploys the commit that CI tested. It writes `wrangler.deploy.jsonc` from `wrangler.jsonc` with the database id in `D1_DATABASE_ID` and this repository's URL. It checks that the result sets `NETWORK` to `testnet`, that `GATEWAY_URL` is the testnet gateway, that `MAINNET_ACK` is empty and that no other Wrangler config file exists. It then applies the D1 migrations and runs `wrangler deploy`. When the two secrets or the `D1_DATABASE_ID` variable are missing, as on a fork or before this setup, the job skips with a notice and does not fail. A fork that sets its own secrets and its own variable deploys to its own account and database, and its probes carry its own repository URL in the `User-Agent`.

A deploy from your own machine uses `D1_DATABASE_ID="<the database_id>" pnpm run deploy`, which runs the same testnet check. A plain `wrangler deploy` reads the placeholder id and Cloudflare refuses it.

## Change the probe rate

`wrangler deploy` replaces every variable set in the Cloudflare dashboard with the values in `wrangler.jsonc`. Change the rate in `wrangler.jsonc`, or the next deploy undoes your change.

Two rates are set here, and different Cloudflare limits bind each one.

- The probe rate. The broadcasts per hour are the probes a tick runs times the number of ticks per hour. A tick runs `PROBES_PER_TICK` probes, or as many as `SUBREQUEST_LIMIT` covers when that is fewer. The dashboard and `cadence.probesPerTick` in the snapshot show the number it runs.
- The publish rate. A tick rebuilds the snapshot and the alerts only when its slot index is a multiple of `PUBLISH_EVERY_TICKS`, so the publish interval is the tick interval times `PUBLISH_EVERY_TICKS`. A rebuild reads the latest probe of every target, which is what costs D1 rows read. The snapshot carries the interval as `publishIntervalMinutes`.

The dashboard, `/api/v1/snapshot.json`, the alerts in `/api/v1/health` and the canary all change once per publish interval, not once per tick. Probes from the ticks between two publishes are stored as they run and appear in the next publish. `prober_stale` and the dashboard's stale banner wait three publish intervals.

| Plan         | `SUBREQUEST_LIMIT` | Probes a tick runs with the committed timing | What limits the publish rate                                                     |
| ------------ | ------------------ | -------------------------------------------- | -------------------------------------------------------------------------------- |
| Workers Free | `50`               | 6                                            | 5 million D1 rows read a day. A publish reads about 11,900 rows on testnet today |
| Workers Paid | `10000`            | `PROBES_PER_TICK`                            | Nothing in practice. `PUBLISH_EVERY_TICKS` can be `1`                            |

The committed configuration runs 6 probes every 2 minutes, 180 broadcasts an hour, and publishes every 10 minutes, at :00, :10, :20 and so on. [DESIGN.md](./DESIGN.md#platform-limits) has the D1 rows that this reads and writes in a day.

On Workers Free, raising `PROBES_PER_TICK` above 6 changes nothing. To probe faster there, run ticks more often, and raise `PUBLISH_EVERY_TICKS` so that publishes do not run more often. Rows written grow with the probe rate and cap it at roughly 9,000 probes a day. A tick that runs fewer probes than `PROBES_PER_TICK` logs `probes_capped`.

1. Edit the `vars` block in `wrangler.jsonc`.
   - To send fewer probes per tick, lower `PROBES_PER_TICK`.
   - On Workers Paid, set `SUBREQUEST_LIMIT` to `10000`. Leave it at `50` on Workers Free. A value above your plan's limit brings the failed ticks back: see [A tick stops as `subrequest_limit`](#a-tick-stops-as-subrequest_limit).
   - To change how often ticks run, change the probe cron in two places, `triggers.crons` and `PROBE_CRON`. The two strings must be the same, character for character. The tick interval is read from `PROBE_CRON`, so it must fire at one fixed interval, such as `*/10 * * * *`, `0 * * * *` or `0 */6 * * *`.
   - To change how often the snapshot is rebuilt, change `PUBLISH_EVERY_TICKS`. A tick publishes when its slot index is a multiple of it. When the publish interval divides the hour, publishes start on the hour and then once per publish interval, so 2-minute ticks with `PUBLISH_EVERY_TICKS` at `5` publish at :00, :10, :20 and so on.
   - Move the canary cron the same way, in `triggers.crons` and `CANARY_CRON`, so that it runs a few minutes after each publish, not after each tick. A probe takes about 3.5 seconds, so a 6-probe tick takes under half a minute and a 30-probe tick about two minutes. Leave more than that. The committed canary runs at :02, :12, :22 and so on, two minutes after each publish.
   - Change nothing else. No other setting and no test names the cadence. A test fails if a cron string and its variable disagree, or if a publish has no canary run before the next publish.
2. Open a pull request with the change.
3. Merge it. The **Deploy** workflow deploys it after CI passes.

## Pause the prober

`PROBE_ENABLED=false` stops the quote requests. The Worker keeps serving the dashboard and the endpoints.

1. In `wrangler.jsonc`, set `"PROBE_ENABLED": "false"`.
2. Deploy from your machine to stop the probes now.

   ```bash
   D1_DATABASE_ID="<the database_id>" pnpm run deploy
   ```

3. Open a pull request with the same change and merge it. Otherwise the next deploy from `main` turns probing back on.

To resume, set `"PROBE_ENABLED": "true"` and repeat the steps.

## Narrow the corridors

`CORRIDOR_FILTER` is a regular expression. The Worker probes only the corridors whose label matches it. A label is `{source chain id}/{symbol}>{destination chain id}/{symbol}`. The matching is in `src/domain/corridors.ts`.

1. Find the chain ids and symbols in the snapshot.

   ```bash
   curl -s "$WORKER_URL/api/v1/snapshot.json" | jq -r '.assets[] | "\(.chainId)/\(.symbol)"'
   ```

2. Set `CORRIDOR_FILTER` in `wrangler.jsonc`. For example, this value keeps only the corridors that leave Arbitrum Sepolia.

   ```jsonc
   "CORRIDOR_FILTER": "^eip155:421614/"
   ```

3. Deploy the change as in [Change the probe rate](#change-the-probe-rate). For an urgent change, deploy from your machine as in [Pause the prober](#pause-the-prober).

An empty `CORRIDOR_FILTER` probes every corridor.

## Wire the canary into monitoring

Two ways exist to learn that an alert fired. With a monitoring system, poll the Worker as this section describes. With only Cloudflare, go to [Alert from Cloudflare alone](#alert-from-cloudflare-alone). You can use both.

### HTTP check

Check `GET $WORKER_URL/api/v1/health` every 5 minutes, with a 30 second timeout.

- Expect `200`.
- Alert on `503`. The response body lists the active alerts.
- Alert on a timeout or a connection error.

```bash
curl -s -o /dev/null -w '%{http_code}\n' --max-time 30 "$WORKER_URL/api/v1/health"
```

### Prometheus

Scrape `/metrics`. Read the metric names from the endpoint itself.

```bash
curl -s "$WORKER_URL/metrics"
```

```yaml
scrape_configs:
  - job_name: corridor-weather
    scheme: https
    metrics_path: /metrics
    scrape_interval: 60s
    static_configs:
      - targets: ["corridor-weather.<your-subdomain>.workers.dev"]
```

### Datadog

Create a Synthetic API test that checks the health endpoint. This definition follows the HTTP test example in the Datadog guide [Create an API test with the API](https://docs.datadoghq.com/synthetics/guide/create-api-test-with-the-api/). Replace the URL, the location, and the notification handle.

```json
{
	"name": "Corridor Weather testnet health",
	"type": "api",
	"subtype": "http",
	"status": "live",
	"tags": ["service:corridor-weather", "env:testnet"],
	"locations": ["aws:us-east-1"],
	"message": "Corridor Weather health is not 200. Read the alert list at https://corridor-weather.<your-subdomain>.workers.dev/api/v1/health and follow docs/RUNBOOK.md. @your-team-handle",
	"config": {
		"request": {
			"url": "https://corridor-weather.<your-subdomain>.workers.dev/api/v1/health",
			"method": "GET"
		},
		"assertions": [{ "type": "statusCode", "operator": "is", "target": 200 }]
	},
	"options": {
		"tick_every": 300,
		"min_failure_duration": 0,
		"min_location_failed": 1,
		"monitor_options": { "renotify_interval": 0 }
	}
}
```

Save the definition as `health-test.json` and send it to the Datadog API. Use the API host of your Datadog site.

```bash
curl -s -X POST "https://api.datadoghq.com/api/v1/synthetics/tests/api" \
	-H "Content-Type: application/json" \
	-H "DD-API-KEY: $DD_API_KEY" \
	-H "DD-APPLICATION-KEY: $DD_APP_KEY" \
	--data @health-test.json
```

## Alert from Cloudflare alone

Use this when no monitoring system polls the Worker. A second Cron Trigger, the canary cron, runs a few minutes after each publish. It posts to a webhook when an alert is raised and when it clears. [DESIGN.md](./DESIGN.md#alert-delivery) explains how it decides.

You need a webhook URL that accepts a JSON `POST`. A Slack incoming webhook, a Mattermost incoming webhook and a Google Chat webhook all accept the default format.

1. Store the URL as a secret. Wrangler asks for the value. Paste the URL there, not on the command line.

   ```bash
   pnpm exec wrangler secret put ALERT_WEBHOOK_URL --config wrangler.jsonc
   ```

   A secret is not a variable. A later `wrangler deploy` keeps it.

2. If the receiver does not accept `{"text": ...}`, set `ALERT_WEBHOOK_FORMAT` to `json` in the `vars` block of `wrangler.jsonc`.

3. To get links in each message, set `PUBLIC_URL` in the same block to the address of the deployed Worker.

4. To be told about `slow_quotes` as well, set `ALERT_MIN_SEVERITY` to `warning`.

5. Deploy the change, as in [Change the probe rate](#change-the-probe-rate).

6. Check that the canary runs. The Worker logs one line per canary run.

   ```bash
   pnpm exec wrangler tail --config wrangler.jsonc
   ```

   Expect `event: 'canary'` once per probe interval. A failed delivery logs `event: 'canary_delivery_failed'` with the reason, and the next run sends the same message again.

Know these limits before you rely on it.

- The canary runs inside the Worker. If Cloudflare stops invoking the Worker, no message is sent. Only an outside check on `/api/v1/health` catches that.
- A fresh deploy has no finished tick. The first canary run can announce `prober_stale`, and the next can clear it.
- Each run sends at most one message. An alert that stays active is announced once.
- A change to the canary's schedule needs two edits in `wrangler.jsonc`: its entry in `triggers.crons`, and `CANARY_CRON`. They must be the same string. A trigger that matches neither `PROBE_CRON` nor `CANARY_CRON` does nothing, and the Worker logs `unknown_cron`.

To stop the messages, delete the secret.

```bash
pnpm exec wrangler secret delete ALERT_WEBHOOK_URL --config wrangler.jsonc
```

## Run the canary drill

The drill proves that the monitor fires when a corridor stops quoting. **Nobody has run this drill yet.** Run it once after you wire up monitoring. With the canary webhook, the same steps prove the push path: expect one raised message after step 6 and one cleared message after step 9.

The drill uses the corridor from Arbitrum Sepolia USDC to Base Sepolia USDC. On 2026-11-22 it quoted 1 USDC and declined 10,000 USDC with `INSUFFICIENT_LIQUIDITY`. Pause any merge to `main` during the drill, because a deploy from `main` resets the configuration.

1. In `wrangler.jsonc`, set the filter to that one corridor.

   ```jsonc
   "CORRIDOR_FILTER": "^eip155:421614/USDC>eip155:84532/USDC$"
   ```

2. Deploy from your machine.

   ```bash
   D1_DATABASE_ID="<the database_id>" pnpm run deploy
   ```

3. Wait for the next publish. Check that every tier of the corridor was quoted.

   ```bash
   curl -s "$WORKER_URL/api/v1/snapshot.json" | jq '.corridors[] | {id, condition, tiers: [.tiers[] | {tier, outcome}]}'
   ```

   If a tier is not `quoted`, the corridor does not quote today. Pick a corridor in the `fair` condition, change the filter to it, and repeat from step 2.

4. In `wrangler.jsonc`, probe one tier only, at an amount above testnet liquidity. The alert needs every configured tier of the corridor to lose its quote, so a single tier makes the drill short.

   ```jsonc
   "AMOUNT_TIERS": "{\"large\":\"10000\"}"
   ```

5. Deploy from your machine again, as in step 2.

6. Wait for the next publish. Check that the health endpoint returns `503` with a `quotes_lost` alert.

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' "$WORKER_URL/api/v1/health"
   curl -s "$WORKER_URL/api/v1/health" | jq '.alerts[] | select(.kind == "quotes_lost")'
   ```

7. Check that your monitor fired once.

8. Restore `AMOUNT_TIERS` to `{"small":"1","typical":"25","large":"100"}` and keep the filter. Deploy from your machine. The alert stays active until a tier of the corridor is quoted again, so health returns `200` only after a tick quotes one and the next publish includes it. Without the filter, that corridor waits for its turn in the full sweep, which can take hours. The dashboard states how long one sweep takes.

9. Wait until health returns `200`. Check that the monitor recovered.

10. Restore `wrangler.jsonc` and redeploy `main`.

    ```bash
    git checkout -- wrangler.jsonc
    gh workflow run deploy.yml --ref main
    ```

## A tick stops as `subrequest_limit`

Cloudflare refused a request because the invocation had made as many as the plan allows. The tick logs at error level with `aborted: "subrequest_limit"`, and `lastTick.aborted` in the snapshot says the same. The probe that was refused is not stored, so the store holds no false `gateway_error`. No alert fires for it.

A tick plans its probes to fit `SUBREQUEST_LIMIT`, so this means the variable is above the limit of the plan the Worker runs on.

1. Check the plan of the Cloudflare account. Workers Free allows 50 subrequests for each invocation. Workers Paid allows 10,000.
2. Set `SUBREQUEST_LIMIT` in `wrangler.jsonc` to that number and deploy.

If `SUBREQUEST_LIMIT` already matches the plan, Cloudflare counts a request that the plan does not. Lower `SUBREQUEST_LIMIT` by 10 to stop the failures, and open an issue with the tick log.

## What each alert means

| Alert            | Severity | Fires when                                                                                                | Check first                                                                                                                                                                                                                |
| ---------------- | -------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prober_stale`   | Critical | The newest tick in the snapshot finished more than three publish intervals ago, or no tick has finished   | Run `pnpm exec wrangler tail corridor-weather` through one publish slot and look for an exception in the tick or the publish. Run `pnpm exec wrangler deployments list` to see whether a recent deploy changed the Worker. |
| `gateway_errors` | Critical | Discovery failed or listed no usable chain, or half or more of the probes in a tick were gateway errors   | Read `lastTick` in `/api/v1/snapshot.json`. `aborted` names the reason when a tick stopped early, and `gatewayErrors` counts the failed probes.                                                                            |
| `quotes_lost`    | Critical | A corridor was quoted in the last 7 days, and the latest probe of every configured tier is now not quoted | Read the corridor history. Its outcome and decline reasons, for example `INSUFFICIENT_LIQUIDITY`, say what the operators answered.                                                                                         |
| `slow_quotes`    | Warning  | The time to the first quote is above `SLOW_QUOTE_MS`                                                      | Compare `firstQuoteMs` across corridors in `/api/v1/snapshot.json` to see whether one corridor or all of them are slow.                                                                                                    |

To read the history of a corridor, URL-encode its id.

```bash
id=$(curl -s "$WORKER_URL/api/v1/health" | jq -r 'first(.alerts[] | select(.corridorId != null)) | .corridorId | @uri')
curl -s "$WORKER_URL/api/v1/corridors/$id/history.json" | jq '.points[-5:]'
```

## Read raw probe data from D1

The tables are `ticks`, `corridors`, `corridor_sets`, `probes`, `probe_declines`, `probe_raw`, `snapshots`, and `alert_notifications`. `corridor_sets` holds the hash of the current corridor list. `corridors.last_seen` is the slot in which the current list was last written, not the last tick. `alert_notifications` holds the alerts the canary has announced and not yet cleared. `probe_raw` keeps the HTTP exchanges of each probe. Each response body is the text the gateway sent, so read it with `json_extract` after parsing the string. Response bodies are cut when one probe passes 900 KiB. `snapshots` holds the snapshot in parts. Concatenate `snapshot_json` in `part` order. Read the columns from the database itself, because migrations can change them.

1. Print the schema of every table.

   ```bash
   pnpm exec wrangler d1 execute corridor-weather --remote --command "SELECT name, sql FROM sqlite_master WHERE type = 'table'"
   ```

2. Run a query.

   ```bash
   pnpm exec wrangler d1 execute corridor-weather --remote --command "SELECT COUNT(*) FROM probes"
   ```

3. Add `--json` to get the result as JSON, for example to pipe it to `jq`.

To query the database that `pnpm run dev` uses, replace `--remote` with `--local`.

## Go to mainnet

Mainnet is blocked on DESIGN.md questions 1 and 4. Question 1 needs a probe rate that the mainnet settler operators agree to. Question 4 needs a legal decision about publishing operator addresses and prices.

After both answers exist, three more changes are needed.

- Record the answers in DESIGN.md.
- Set `MAINNET_ACK` to `cadence-and-publishing-agreed` in the mainnet configuration. The Worker refuses `NETWORK=mainnet` without it.
- Change the deploy workflow in a reviewed pull request. `.github/workflows/deploy.yml` refuses any `NETWORK` but `testnet`, and the `testnet` environment holds the only Cloudflare credentials.
