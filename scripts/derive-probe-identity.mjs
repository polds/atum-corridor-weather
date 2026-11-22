#!/usr/bin/env node
// Prints the keyless probe accounts derived from the public label.
// evm:    EIP-55 of the last 20 bytes of keccak256(label)
// tron:   base58check(0x41 || those 20 bytes)
// solana: base58(sha256(label))
import {
	concat,
	dataSlice,
	encodeBase58,
	getAddress,
	keccak256,
	sha256,
	toUtf8Bytes,
} from "ethers";

const LABEL = "corridor-weather-probe/v1";

const body = dataSlice(keccak256(toUtf8Bytes(LABEL)), 12);
const tronPayload = concat(["0x41", body]);
const tronChecksum = dataSlice(sha256(sha256(tronPayload)), 0, 4);

const identity = {
	eip155: getAddress(body),
	tron: encodeBase58(concat([tronPayload, tronChecksum])),
	solana: encodeBase58(sha256(toUtf8Bytes(LABEL))),
};

console.log(`label: ${LABEL}`);
for (const [namespace, account] of Object.entries(identity)) {
	console.log(`${namespace.padEnd(7)} ${account}`);
}
