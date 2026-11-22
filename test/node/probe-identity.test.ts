import {
	concat,
	dataSlice,
	encodeBase58,
	getAddress,
	keccak256,
	sha256,
	toUtf8Bytes,
} from "ethers";
import { describe, expect, it } from "vitest";
import { PROBE_IDENTITY, PROBE_IDENTITY_LABEL } from "../../src/domain/identity";

describe("probe identity", () => {
	const label = toUtf8Bytes(PROBE_IDENTITY_LABEL);
	const body = dataSlice(keccak256(label), 12);

	it("is derived from the public label corridor-weather-probe/v1", () => {
		expect(PROBE_IDENTITY_LABEL).toBe("corridor-weather-probe/v1");
	});

	it("uses the EIP-55 form of the last 20 bytes of keccak256(label) on EVM chains", () => {
		expect(PROBE_IDENTITY.eip155).toBe(getAddress(body));
	});

	it("uses base58check of 0x41 and the same 20 bytes on Tron", () => {
		const payload = concat(["0x41", body]);
		const checksum = dataSlice(sha256(sha256(payload)), 0, 4);
		expect(PROBE_IDENTITY.tron).toBe(encodeBase58(concat([payload, checksum])));
	});

	it("uses base58 of sha256(label) on Solana", () => {
		expect(PROBE_IDENTITY.solana).toBe(encodeBase58(sha256(label)));
	});
});
