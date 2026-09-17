# @arcdraw/relayer

A permissionless relayer for ArcDraw. It watches `RandomnessRequested` events, waits for each pinned drand
quicknet round, verifies the beacon offchain, simulates, then calls `fulfillBatch` (one BLS verification per round)
and collects the USDC bounties. **Anyone can run one**; several relayers can race safely.

## TL;DR

```bash
pnpm install && pnpm --filter "@arcdraw/relayer..." build
cp .env.example .env    # repo root; set COORDINATOR_ADDRESS (+ RELAYER_PRIVATE_KEY for live mode)

pnpm relayer:dry-run    # simulate only: eth_call + eth_estimateGas, no key needed, nothing sent
pnpm relayer            # live: sends fulfillBatch txs signed by RELAYER_PRIVATE_KEY
curl localhost:8787/healthz
```

## Loop (one tick every `RELAYER_POLL_MS`)

```
getBlockNumber -> getLogs(cursor+1..head) in <= 10,000-block windows -> persist cursor after each window
                  requests with bounty < RELAYER_MIN_BOUNTY are never tracked (a bounty can only go down)
due = pending requests whose roundTimestamp <= head block timestamp          (chain clock, like the contract)
forget inflight records of rounds with nothing due once their nonce is used
for each round (highest total bounty first, then oldest), batches of RELAYER_MAX_BATCH, until 30s of tick time:
  inflight tx for this round?  -> receipt? settle. Unconfirmed < RELAYER_RECEIPT_TIMEOUT_MS? skip.
                                  Past the timeout: nonce used -> drop; still in mempool -> replace with the
                                  SAME nonce and +25% fees (never a second tx); gone -> drop and resend
  getRequest(ids)              -> drop fulfilled; drop refunded / below RELAYER_MIN_BOUNTY from state
  roundRandomness(round) set?  -> no beacon needed (cheap path)
  else fetchBeacon + verify    -> retry w/ backoff on fetch errors, skip forged beacons
  gasPrice > max?              -> skip
  simulate fulfillBatch        -> eth_call + estimateGas; skip on revert (e.g. RoundNotReached)
  dry-run?                     -> log `dry_run_would_fulfill` and stop here
  send (gas = estimate + buffer), record inflight (hash, nonce, fees), wait receipt, log `fulfilled`
  receipt wait timed out?      -> log `skip_receipt_timeout`, keep inflight (not a failed tick)
```

## Configuration

All config comes from environment variables, validated with Zod at startup (exit code 2 on invalid config;
the key's value is never printed). `node --env-file-if-exists=../../.env` is used by the `start` scripts.

| Variable | Default | Meaning |
|---|---|---|
| `ARC_RPC_URL` | `https://rpc.mainnet.arc.io` | JSON-RPC endpoint |
| `ARC_CHAIN_ID` | `5042` | Checked against the RPC at boot (`5042002` = testnet) |
| `COORDINATOR_ADDRESS` | known deployment | Required until the SDK ships the mainnet address |
| `COORDINATOR_DEPLOY_BLOCK` / `RELAYER_START_BLOCK` | head | First block to scan when no state file exists |
| `RELAYER_PRIVATE_KEY` | - | Signer for live mode. Use a dedicated low-balance hot wallet |
| `RELAYER_DRY_RUN` | `false` | Simulate only; no key required |
| `RELAYER_ADDRESS` | key address / `0x…dEaD` | `from` for dry-run simulations |
| `DRAND_URLS` | api.drand.sh, api2.drand.sh, drand.cloudflare.com | Comma-separated relays, tried in order |
| `DRAND_TIMEOUT_MS` | `5000` | Per-relay timeout |
| `RELAYER_POLL_MS` | `1500` | Tick interval |
| `RELAYER_MIN_BOUNTY` | `0` | USDC (decimal, e.g. `0.01`); cheaper requests are left to others and not tracked (raising it later needs no action; lowering it needs a rescan from `RELAYER_START_BLOCK` with a fresh state file) |
| `RELAYER_MAX_GAS_PRICE_GWEI` | `100` | Skip sending above this (Arc floor is 20 gwei) |
| `RELAYER_MAX_BATCH` | `20` | Request ids per `fulfillBatch` |
| `RELAYER_GAS_BUFFER_PCT` | `20` | Added to the gas estimate |
| `RELAYER_RECEIPT_TIMEOUT_MS` | `60000` | Receipt wait; after it, a still-pending tx is replaced with the same nonce |
| `RELAYER_ERROR_BUDGET` | `5` | Consecutive failed ticks before exit(1) (let the supervisor restart) |
| `RELAYER_SCAN_CHUNK` | `10000` | getLogs window (max 10,000 on Arc) |
| `RELAYER_STATE_FILE` | `.state/cursor.json` | Cursor, pending set, inflight txs (atomic writes) |
| `RELAYER_HEALTH_PORT` | unset | Enables `GET /healthz` (200 when ticking, 503 when stale) |
| `RELAYER_SHUTDOWN_TIMEOUT_MS` | `30000` | Hard exit if graceful shutdown takes longer |
| `LOG_LEVEL` | `info` | `debug` adds per-tick lines |

## Logs

One JSON object per line on stdout. Every line has `ts, level, msg, service:"relayer", runId`. Lines inside a tick
carry `tickId`; per-round lines add `round` and `requestIds`; transaction lines add `txHash`. Filter a single batch
with `jq 'select(.tickId=="3f9c1a2b")'`.

```json
{"ts":"2026-09-17T06:44:22.561Z","level":"info","msg":"tx_sent","service":"relayer","runId":"7ca5…","tickId":"ea8258e9","round":"32274500","requestIds":["12","13"],"txHash":"0x…","gasLimit":"536270","estCostUsdc":"0.0089"}
{"ts":"2026-09-17T06:44:23.102Z","level":"info","msg":"fulfilled","service":"relayer","runId":"7ca5…","tickId":"ea8258e9","round":"32274500","requestIds":["12","13"],"txHash":"0x…","gasUsed":"446892","costUsdc":"0.0089","batch_size":2,"fulfilled_total":14,"callbacksFailed":[],"bountyPaid":"20000","latency_ms":2000}
```

Messages: `relayer_started`, `cursor_initialized`, `logs_scanned`, `beacon_fetched`, `dry_run_would_fulfill`,
`tx_sent`, `fulfilled`, `tx_reverted`, `skip_<reason>` (`inflight`, `drand_unavailable`, `invalid_beacon`,
`gas_price_too_high`, `simulation_reverted`, `send_reverted`), `rpc_retry`, `drand_retry`, `tick_failed`,
`error_budget_exhausted`, `shutdown_requested`, `relayer_stopped`.

## Failure handling

| Situation | Behaviour |
|---|---|
| Another relayer fulfilled first | The status re-read right before simulating drops the id. If the race is lost after that, `fulfillBatch` skips already-fulfilled ids onchain instead of reverting, so the cost is at most one cheap tx with no bounty |
| Restart mid-send | The tx hash is persisted before waiting; the next tick checks its receipt before resubmitting |
| drand relay down / round not out yet | Fallback relays, exponential backoff with jitter (cap 30 s), retried next tick |
| Forged beacon | Rejected offchain (BLS + canonical encoding), never sent: an off-curve signature would burn all gas onchain |
| RPC errors | Retried with backoff inside the tick; `RELAYER_ERROR_BUDGET` consecutive failed ticks exit(1) |
| SIGINT / SIGTERM | Stops at the next RPC boundary. Once a tx is sent, its hash is persisted and its receipt awaited before exiting. Then the health server closes and the process exits 0. A second signal forces exit |

Arc has deterministic finality, so one receipt is final and the scanner needs no reorg handling.

## Docker

```bash
docker build -f services/relayer/Dockerfile -t arcdraw-relayer .           # from the repo root
docker run --rm --env-file .env -p 8787:8787 -v arcdraw-state:/data arcdraw-relayer
```

The image runs as `node`, keeps state in `/data`, exposes `/healthz` on 8787 and has a `HEALTHCHECK`.
The key is only read from the environment at runtime.

## Tests

```bash
pnpm --filter @arcdraw/relayer test
```

- Unit: config validation and key redaction, JSON logger, retry/backoff, state file round-trip.
- End to end against a local `anvil --hardfork osaka` (skipped if `anvil` or `contracts/out` is missing):
  deploys MockUSDC, `ArcDrawCoordinator` and a recording consumer, requests with the SDK, and runs the relayer with a
  mocked drand HTTP layer serving **real quicknet signatures** for rounds 1000000..1000002. It checks the batch
  fulfillment, bounty payout, callback, derived randomness, idempotent re-ticks and log replays, dry-run (nonce
  unchanged), the lost-race path, forged beacon rejection, the inflight guard and graceful shutdown of `run()`.
  anvil's unlocked dev accounts sign the transactions, so the tests handle no keys.

## Security

- Use a dedicated hot wallet with a small USDC balance for gas. The relayer never logs the key.
- Fulfillment is permissionless: the relayer cannot change the randomness, only deliver it (or not).
