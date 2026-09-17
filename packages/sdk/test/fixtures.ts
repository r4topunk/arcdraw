import type { Beacon } from "../src/drand.js";

// Real quicknet beacons, identical to contracts/test/fixtures/Quicknet.sol (never fetched at test time).
export const BEACON_A: Beacon = {
  round: 1000000n,
  signature:
    "0x83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72",
  randomness: "0xb22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3",
};
export const BEACON_B: Beacon = {
  round: 1000001n,
  signature:
    "0xa5bd91e5e2d8c0bf51bffdfad87eef34348fd9c0b2df2bee39db90bdef7e1399b1a77bb2fe98b24d84c0936a306c4218",
  randomness: "0x9f45f439afd81e9846b3b4dc5e3e6051922c73c8459d18e9d507b52ddbd884ff",
};
export const BEACON_C: Beacon = {
  round: 1000002n,
  signature:
    "0xa96e2a020098645aa4f912dcca317a67e98c39909fe1a037798fb503f04272b8153bab438c7e8d298593af1bdf29e5c5",
  randomness: "0x018e0e0c9e0d7906762eca633fab3ec5e97ee4cb8949e4eb9ee589160b49263d",
};

/** Quicknet.VECTOR_* in Solidity: keccak256(abi.encode(RAND_A, 5042, 0x...A4CD4A11, 1)). */
export const DERIVE_VECTOR = {
  coordinator: "0x00000000000000000000000000000000A4Cd4A11",
  chainId: 5042,
  requestId: 1n,
  expected: "0x67c3610c49e54102c1d8426213165d1c3bad88236befe84d4b1c3d2478a302fa",
} as const;

/** drand HTTP JSON body (no 0x prefixes) for a beacon. */
export const drandJson = (b: Beacon) => ({
  round: Number(b.round),
  randomness: b.randomness.slice(2),
  signature: b.signature.slice(2),
});
