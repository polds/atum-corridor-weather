# Corridor Weather runbook

These guides operate the testnet deployment of Corridor Weather. Corridor Weather is an unofficial, community project and not an Atum product. [DESIGN.md](./DESIGN.md) explains why the system works the way it does.

Every guide assumes a checkout of `main`, Node 22, pnpm 10, and `pnpm install`. Commands that change Cloudflare need `pnpm exec wrangler login` first. Commands that change GitHub need `gh auth login` first.

In the commands below, `WORKER_URL` is the URL that `wrangler deploy` prints, for example `https://corridor-weather.<your-subdomain>.workers.dev`.

```bash
export WORKER_URL="https://corridor-weather.<your-subdomain>.workers.dev"
```

## First deploy

Do not deploy before DESIGN.md question 1 has an answer. The default rate sends about 360 quote broadcasts per hour to the settler operators.

1. Log in to Cloudflare.

   ```bash
   pnpm exec wrangler login
   ```

2. Create the D1 database.

   ```bash
   pnpm exec wrangler d1 create corridor-weather
   ```

3. Copy the `database_id` that the command prints into `d1_databases[0].database_id` in `wrangler.jsonc`. It replaces `00000000-0000-0000-0000-000000000000`.

4. Create the tables.

   ```bash
   pnpm exec wrangler d1 migrations apply corridor-weather --remote
   ```

5. Build the dashboard and deploy the Worker. Wrangler prints the Worker URL. Save it as `WORKER_URL`.

   ```bash
   pnpm run build:dashboard
   pnpm exec wrangler deploy
   ```

6. Wait for the first tick, up to 5 minutes. Then check the health endpoint.

   ```bash
   curl -i "$WORKER_URL/api/v1/health"
   ```

7. Open a pull request that commits the new `database_id` to `wrangler.jsonc`.

8. Create the `testnet` environment on GitHub.

   ```bash
   gh api --method PUT repos/polds/atum-corridor-weather/environments/testnet
   ```

9. Create a Cloudflare API token that can edit Workers scripts and D1 databases in your account.

10. Print your Cloudflare account id.

    ```bash
    pnpm exec wrangler whoami
    ```

11. Save the token and the account id as secrets of the `testnet` environment. Each command asks for the value.

    ```bash
    gh secret set CLOUDFLARE_API_TOKEN --env testnet --repo polds/atum-corridor-weather
    gh secret set CLOUDFLARE_ACCOUNT_ID --env testnet --repo polds/atum-corridor-weather
    ```

12. In the branch protection rule for `main`, require the `ci-ok` status check. It passes only when every CI job passes.

13. Run the deploy workflow once to check the secrets.

    ```bash
    gh workflow run deploy.yml --ref main
    gh run watch
    ```

From then on, the **Deploy** workflow runs after every **CI** run that passes on a push to `main`. It deploys the commit that CI tested. It checks that `wrangler.jsonc` sets `NETWORK` to `testnet`, that `GATEWAY_URL` is the testnet gateway, that `MAINNET_ACK` is empty and that no other Wrangler config file exists. It then applies the D1 migrations and runs `wrangler deploy`. When the two secrets are missing, as on a fork, the job ends with a "Deploy skipped" notice and deploys nothing.

A deploy from your own machine skips the workflow's testnet check. Read `wrangler.jsonc` before you run `wrangler deploy` by hand.

## Change the probe rate

`wrangler deploy` replaces every variable set in the Cloudflare dashboard with the values in `wrangler.jsonc`. Change the rate in `wrangler.jsonc`, or the next deploy undoes your change.

The broadcasts per hour are `PROBES_PER_TICK * 60 / TICK_INTERVAL_MINUTES`.

1. Edit the `vars` block in `wrangler.jsonc`.
   - To send fewer probes per tick, lower `PROBES_PER_TICK`.
   - To run ticks less often, change the cron expression in `triggers.crons` and set `TICK_INTERVAL_MINUTES` to the same interval. For example, use `*/10 * * * *` with `"10"`.
2. Open a pull request with the change.
3. Merge it. The **Deploy** workflow deploys it after CI passes.

## Pause the prober

`PROBE_ENABLED=false` stops the quote requests. The Worker keeps serving the dashboard and the endpoints.

1. In `wrangler.jsonc`, set `"PROBE_ENABLED": "false"`.
2. Deploy from your machine to stop the probes now.

   ```bash
   pnpm run build:dashboard
   pnpm exec wrangler deploy
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

The Worker computes alerts but sends no notification. Your monitoring sends the page.

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

## Run the canary drill

The drill proves that the monitor fires when a corridor stops quoting. **Nobody has run this drill yet.** Run it once after you wire up monitoring.

The drill uses the corridor from Arbitrum Sepolia USDC to Base Sepolia USDC. On 2026-11-22 it quoted 1 USDC and declined 10,000 USDC with `INSUFFICIENT_LIQUIDITY`. Pause any merge to `main` during the drill, because a deploy from `main` resets the configuration.

1. In `wrangler.jsonc`, set the filter to that one corridor.

   ```jsonc
   "CORRIDOR_FILTER": "^eip155:421614/USDC>eip155:84532/USDC$"
   ```

2. Deploy from your machine.

   ```bash
   pnpm run build:dashboard
   pnpm exec wrangler deploy
   ```

3. Wait one tick. Check that every tier of the corridor was quoted.

   ```bash
   curl -s "$WORKER_URL/api/v1/snapshot.json" | jq '.corridors[] | {id, condition, tiers: [.tiers[] | {tier, outcome}]}'
   ```

   If a tier is not `quoted`, the corridor does not quote today. Pick a corridor in the `fair` condition, change the filter to it, and repeat from step 2.

4. In `wrangler.jsonc`, raise the large tier above testnet liquidity.

   ```jsonc
   "AMOUNT_TIERS": "{\"small\":\"1\",\"typical\":\"25\",\"large\":\"10000\"}"
   ```

5. Deploy from your machine again, as in step 2.

6. Wait for the next tick. Check that the health endpoint returns `503` with a `quotes_lost` alert.

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' "$WORKER_URL/api/v1/health"
   curl -s "$WORKER_URL/api/v1/health" | jq '.alerts[] | select(.kind == "quotes_lost")'
   ```

7. Check that your monitor fired once.

8. Restore `AMOUNT_TIERS` to `{"small":"1","typical":"25","large":"100"}` and keep the filter. Deploy from your machine. The alert compares the latest probe of a tier with the probe before it, so the large tier must be quoted again before health returns `200`. Without the filter, that corridor waits for its turn in the full sweep, about 4.6 hours.

9. Wait until health returns `200`. Check that the monitor recovered.

10. Restore `wrangler.jsonc` and redeploy `main`.

    ```bash
    git checkout -- wrangler.jsonc
    gh workflow run deploy.yml --ref main
    ```

## What each alert means

| Alert            | Severity | Fires when                                                                                              | Check first                                                                                                                                                                             |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prober_stale`   | Critical | No tick finished within three intervals                                                                 | Run `pnpm exec wrangler tail corridor-weather` through one tick and look for an exception. Run `pnpm exec wrangler deployments list` to see whether a recent deploy changed the Worker. |
| `gateway_errors` | Critical | Discovery failed or listed no usable chain, or half or more of the probes in a tick were gateway errors | Read `lastTick` in `/api/v1/snapshot.json`. `aborted` names the reason when a tick stopped early, and `gatewayErrors` counts the failed probes.                                         |
| `quotes_lost`    | Critical | A corridor tier was quoted on its previous probe and is not quoted now                                  | Read the corridor history. Its outcome and decline reasons, for example `INSUFFICIENT_LIQUIDITY`, say what the operators answered.                                                      |
| `slow_quotes`    | Warning  | The time to the first quote is above `SLOW_QUOTE_MS`                                                    | Compare `firstQuoteMs` across corridors in `/api/v1/snapshot.json` to see whether one corridor or all of them are slow.                                                                 |

To read the history of a corridor, URL-encode its id.

```bash
id=$(curl -s "$WORKER_URL/api/v1/health" | jq -r 'first(.alerts[] | select(.corridorId != null)) | .corridorId | @uri')
curl -s "$WORKER_URL/api/v1/corridors/$id/history.json" | jq '.points[-5:]'
```

## Read raw probe data from D1

The tables are `ticks`, `corridors`, `probes`, `probe_declines`, `probe_raw`, and `snapshots`. `probe_raw` keeps the HTTP exchanges of each probe. Each response body is the text the gateway sent, so read it with `json_extract` after parsing the string. Response bodies are cut when one probe passes 900 KiB. `snapshots` holds the snapshot in parts. Concatenate `snapshot_json` in `part` order. Read the columns from the database itself, because migrations can change them.

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
