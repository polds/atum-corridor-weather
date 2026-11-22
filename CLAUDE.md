# Corridor Weather

Unofficial, open-source prober and public dashboard for Atum quote corridors. It is not an Atum product. Say so in every public artifact you add: README sections, dashboard pages, API responses that a person reads.

Read `docs/DESIGN.md` before you change behavior. It holds the design, the safety rules and the open questions.

## Hard rules

- Never send `sender_auth`. Never call an award or payment endpoint. Never add a key or a secret that can spend.
- The gateway client allows three routes. Do not add a fourth without changing `docs/DESIGN.md` first.
- Do not import `@atumlabs/payment-gateway-client` under `src/`. The Worker builds quote request bodies itself in `src/gateway/quote-request.ts`. The SDK (6.0.0 or later) is a dev dependency, and the conformance test requires the two bodies to be equal. Change the builder and that test together.
- Testnet only. `NETWORK=mainnet` needs `MAINNET_ACK` and a human decision (DESIGN.md, questions 1 and 4).
- Do not send quote requests to the real gateway from tests or CI. Tests use the fixtures in `test/fixtures/gateway`.
- Log every doc gap or API surprise in `FRICTION.md` when you hit it.

## Commands

```bash
pnpm install
pnpm run check        # lint, typecheck, test, build. Run before every commit.
pnpm run dev          # local Worker with a local D1. Trigger a tick: curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
pnpm run lint:fix
```

Use pnpm. `npm install` fails on this dependency tree.

## Layout

- `src/domain/` is pure. No I/O, no clock, no globals. Pass time and randomness in.
- `src/gateway/` and `src/worker/config.ts` are the only places that parse external data. Use zod there and trust the types everywhere else.
- `src/store/` is the only code that talks to D1.
- `dashboard/` imports types from `src/domain/snapshot.ts` and nothing else from `src/`.

## Agent tooling

- Plugin `pstack@cursor-plugins` is enabled in `.claude/settings.json`.
- pstack per-role models live in `.claude/rules/pstack-models.md`. Re-run `/pstack:setup-pstack` to change them.
- Start non-trivial work with `/pstack:poteto-mode`.
- If the plugin is missing, install it. A plugin installed during a session loads in the next session.

```
/plugin marketplace add cursor/plugins
/plugin install pstack@cursor-plugins
```
