# Contributing to Corridor Weather

Corridor Weather is an unofficial, community project and not an Atum product. Read [docs/DESIGN.md](docs/DESIGN.md) before you change behavior. It holds the design, the safety rules, and the open questions.

## Set up

1. Install Node 22. The version is in `.nvmrc`.
2. Enable pnpm 10. Corepack reads the version from `packageManager` in `package.json`.

   ```bash
   corepack enable pnpm
   ```

3. Install the dependencies. Use pnpm, because `npm install` fails on this dependency tree.

   ```bash
   pnpm install
   ```

4. Run every check before each commit. CI runs the same scripts.

   ```bash
   pnpm run check
   ```

`pnpm run check` runs `lint`, `typecheck`, `test`, and `build` in that order. `pnpm run lint:fix` applies the Biome fixes it can.

To run the Worker locally, follow the quick start in [README.md](README.md#quick-start).

## Layout rules

- `src/domain/` is pure. It has no I/O, no clock, and no globals. Pass time and randomness in.
- `src/gateway/` and `src/worker/config.ts` are the only places that parse external data. Use zod there and trust the types everywhere else.
- `src/store/` is the only code that talks to D1.
- `src/notify/` is the only code that posts to the alert webhook. The webhook URL is a secret: log its origin only.
- `dashboard/` imports types from `src/domain/snapshot.ts` and nothing else from `src/`.

## Safety rules

- Never send `sender_auth`. Never call an award or payment endpoint. Never add a key or a secret that can spend.
- The gateway client allows three routes. To add a fourth, change `docs/DESIGN.md` first.
- Do not import `@atumlabs/payment-gateway-client` under `src/`. The Worker builds quote request bodies in `src/gateway/quote-request.ts`. The SDK, 6.0.0 or later, is a dev dependency, and a conformance test requires the two bodies to be equal. Change the builder and that test together.
- Testnet only. `NETWORK=mainnet` needs `MAINNET_ACK` and a human decision. See DESIGN.md, questions 1 and 4.

## Tests never call the real gateway

Tests and CI must not send requests to the real Atum gateway. Use the recorded responses in `test/fixtures/gateway`. If you need a new fixture, say in the pull request where the response came from and when.

The one exception is the weekly **Gateway contract** workflow. It sends one `GET /v1/defaults` request and no quote request.

## Log friction

When the Atum docs or API surprise you, add an item to [FRICTION.md](FRICTION.md) in the same pull request. Number it after the last item and use the same four bullets.

- **Expected.** What the docs or the API led you to expect.
- **Happened.** What you saw, with the exact response or error.
- **Workaround.** What you did instead, if anything.
- **Would help.** The doc change or API change that would have prevented it.

To report friction without a code change, open a **Doc friction** issue.

## Commits and pull requests

Write commit messages and pull request titles as `type(scope): subject`, for example `fix(gateway): keep the raw body of a 429 response`. Use a type such as `feat`, `fix`, `docs`, `test`, `refactor`, `ci`, or `chore`.

The pull request template has these headings, in this order. Drop a heading that would be empty, and keep the body under 40 lines.

1. `Why`
2. `What changed`
3. `Scope`
4. `Tradeoffs`
5. `Blast Radius`
6. `Verification`

Branch protection requires the `ci-ok` check, which passes only when lint, typecheck, test, build, and workflow lint all pass.
