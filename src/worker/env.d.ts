// Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them.
// Set with `wrangler secret put ALERT_WEBHOOK_URL`. Parsed by src/worker/config.ts.
interface Env {
	readonly ALERT_WEBHOOK_URL?: string;
}
declare namespace Cloudflare {
	interface Env {
		readonly ALERT_WEBHOOK_URL?: string;
	}
}
