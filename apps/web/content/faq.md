# FAQ

## Why not use `block.prevrandao`?

On Arc it is always `0`. `blockhash` is known to the block producer first, and commit-reveal needs every participant online and suffers from the last-revealer problem. ArcDraw uses an external beacon whose value nobody knows in advance and anyone can check.

## Who do I have to trust?

The drand League of Entropy. The quicknet signature is produced by a threshold of independent organisations; if a threshold colluded, they could predict rounds. Nobody else can influence the value: not the requester, not the relayer, not Arc validators and not the ArcDraw deployer (the coordinator has no owner and cannot be upgraded).

## Is this audited?

No. The coordinator and the vendored [randa-mu/bls-solidity](https://github.com/randa-mu/bls-solidity) library are **unaudited**, so ArcDraw is labelled experimental. Do not secure value you cannot afford to lose.

## How fast is it?

`requestRandomness` pins `current round + 4`, published 9 to 12 seconds after the request block. A relayer then needs one Arc block (about 0.5 s) plus its polling delay. Expect a result within roughly 10 to 15 seconds.

## What does it cost?

At Arc's 20 gwei floor, paid in USDC: about 0.0019 USDC to request, 0.0063 USDC to fulfill the first request of a round (including BLS verification) and 0.0015 USDC for each further request on that round. See the [gas report](/docs/gas/).

## Why would anyone fulfill my request?

Attach a USDC bounty and any relayer can claim it. The reference relayer only sends a batch when its bounties cover the worst-case gas cost with a margin (about 0.01 USDC for a request without callback at the 20 gwei floor; more with a callback). Without a bounty you depend on voluntary relayers, or you press "Fulfill it yourself" in the [app](/app/). The beacon is public, so no special permission is needed.

## Can a requester cancel a draw they do not like?

No. The drand round is pinned at request time, which fixes the outcome. `refund` only returns the bounty after a 1-hour timeout, and the request remains fulfillable with the same value.

## Can a relayer pick a better signature?

No. A BLS signature for a given round and key is unique, and the coordinator rejects non-canonical encodings of the same point, so exactly one byte string is valid per round.

## What if Arc's `block.timestamp` lags real time?

The `+4` round margin means the pinned round is published strictly more than 9 seconds after `block.timestamp`. If Arc's timestamp lagged wall clock by 9 seconds or more, the round could already be public at request time. This is a documented assumption. Use `requestRandomnessAtRound` with a larger margin for high-value draws.

## What if drand stops?

Requests on unpublished rounds stay pending, and bounties can be refunded after the timeout. drand quicknet has run since August 2023 across many independent operators.

## Why is the demo an allocation and not a game?

Arc is a finance-first chain. The FairAllocation demo covers a real need: choosing the winners of an oversubscribed USDC sale fairly, with full refunds for everyone else.

## Does this website track me?

No analytics, trackers or cookies. The app talks only to the Arc RPC, the drand HTTP API and your wallet.
