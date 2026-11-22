import type { ProbeIdentity } from "./types";

/** The public label the probe accounts derive from. */
export const PROBE_IDENTITY_LABEL = "corridor-weather-probe/v1";

/**
 * Keyless probe accounts. Each is a hash of `PROBE_IDENTITY_LABEL`, so no
 * private key exists for any of them. `scripts/derive-probe-identity.mjs`
 * recomputes them.
 */
export const PROBE_IDENTITY: ProbeIdentity = {
	eip155: "0xD5C4D0bbcC3f01886cb1E8E29BB348776892270F",
	tron: "TVTWhtawdkwzezxjU4qi7k4FDqFtn7X5N1",
	solana: "5YdDoh63Jeu5WMMwxfwYS5uHE5Sru6M8BcUech2G671N",
};
