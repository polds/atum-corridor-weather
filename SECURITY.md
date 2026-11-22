# Security policy

Corridor Weather is an unofficial, community project and not an Atum product.

## Report a vulnerability

Report it privately through GitHub private vulnerability reporting on this repository. Open the [Security tab](https://github.com/polds/atum-corridor-weather/security) and select **Report a vulnerability**. Do not open a public issue.

Include the commit or deployment you tested, the steps to reproduce, and what an attacker gains.

## In scope

- The Worker in `src/` and its HTTP endpoints.
- The dashboard in `dashboard/`.
- The GitHub workflows and scripts in `.github/`.
- Anything that would let this project spend funds, sign for an account, or send a request outside its three allowed gateway routes.

## Out of scope

- The Atum gateway, the settlers, and the Atum SDK. This project cannot fix them. Report them to Atum.
- Rate or volume of probe traffic. To ask for a lower rate, open an issue as the README explains.

## Safety properties

These properties hold by design. A change that breaks one is a vulnerability.

- **No keys.** The probe accounts have no private key. Each address comes from the hash of a public label, so no key for it exists.
- **No secrets in the Worker.** The Worker's only bindings are one D1 database and the static assets. The only secret is the Cloudflare deploy token, which lives in the `testnet` environment on GitHub and reaches only the deploy steps.
- **Three routes.** The gateway client allows `GET /v1/defaults`, `POST /v1/payments/quote-requests` to create a quote request, and one read of that quote request. It refuses every other path before it sends anything. It never sends `sender_auth` and never calls an award endpoint.
