# DEPLOY: Arc mainnet runbook

Owner-run. This runbook takes ArcDraw from a clean checkout to deployed contracts, a hosted site, a running relayer and recorded proof txs on Arc mainnet.
Commands are **bash**. On fish, run `bash` first, or wrap each block in `bash -c '…'`.

> Nothing in this repo sends transactions on its own. Every step that spends USDC is marked **[SPENDS]**.
> Never paste a private key into a chat, an issue or a committed file. Signers are a Foundry keystore (deployer) or a `.env` file on the relayer host (gitignored).

## TL;DR

```bash
pnpm install && pnpm run verify                                                          # 0. local green
cast wallet new ~/.foundry/keystores arcdraw-deployer                                    # 2. keystore (prompts for a password)
cd contracts && forge script script/Deploy.s.sol --rpc-url arc_mainnet --account arcdraw-deployer            # 3a. simulate
forge script script/Deploy.s.sol --rpc-url arc_mainnet --account arcdraw-deployer --broadcast                # 3b. [SPENDS] deploy
cd .. && node contracts/script/write-deployment.mjs --chain 5042 && pnpm --filter @arcdraw/sdk deployments  # 5. record
pnpm build   # 6. site with addresses baked in -> apps/web/out
pnpm relayer # 7. [SPENDS] relayer (after .env is filled)
```

## 0. Preconditions

| Check | Command | Expected |
|---|---|---|
| Toolchain | `forge --version && node -v && pnpm -v` | forge 1.x (Osaka), node >= 22, pnpm 11 |
| Submodules | `git submodule update --init --recursive` | `contracts/lib/forge-std` populated |
| Green build | `pnpm install && pnpm run verify` | exit 0 (build, drift checks, lint, typecheck, tests) |
| RPC reachable | `cast chain-id --rpc-url https://rpc.mainnet.arc.io` | `5042` |
| CREATE2 deployer present | `cast code 0x4e59b44847b379578588920cA78FbF26c0B4956C --rpc-url https://rpc.mainnet.arc.io` | non-empty bytecode |

## 1. Acquire about 5 USDC on Arc mainnet

On Arc, USDC is the gas token. A wallet's USDC balance pays for gas and also covers bounties and the demo.

| Wallet | Purpose | Suggested balance |
|---|---|---|
| `arcdraw-deployer` (Foundry keystore) | Deploy 2 contracts (~6.95M gas simulated, 0.14 USDC at 20 gwei, ~0.3 USDC at 41 gwei), proof requests, create the FairAllocation sale | 1.5 USDC |
| `relayer` hot wallet (dedicated, never reused) | `fulfill` / `fulfillBatch` gas (~0.006 USDC per fresh round) | 1.0 USDC |
| Browser wallet(s) for the demo | Web app requests plus 5 FairAllocation subscribers (0.1 USDC price + gas each) | 5 × 0.3 = 1.5 USDC |
| Buffer | Gas spikes, retries | 1.0 USDC |

How to fund:
1. Bridge USDC from another chain to Arc mainnet with Circle's CCTP (App Kit Bridge, see https://docs.arc.io/app-kit/bridge.md), or withdraw from an exchange that supports Arc. UNKNOWN: which exchanges support direct Arc withdrawals today.
2. Send it to the deployer address first (see step 2 for the address), then send some on to the relayer and demo wallets.
3. Check a balance: `cast balance <address> --rpc-url https://rpc.mainnet.arc.io --ether` shows native USDC with 18 decimals. The ERC-20 view of the same balance is `cast call 0x3600000000000000000000000000000000000000 "balanceOf(address)(uint256)" <address> --rpc-url https://rpc.mainnet.arc.io` (6 decimals).

## 2. Create the Foundry keystore (deployer)

```bash
cast wallet new ~/.foundry/keystores arcdraw-deployer          # new key, encrypted with a password you choose
# or import a key you already control (you paste it into the prompt; it is never echoed or stored in plain text):
# cast wallet import arcdraw-deployer --interactive
cast wallet address --account arcdraw-deployer                 # the deployer address to fund in step 1
cast wallet list                                               # confirm arcdraw-deployer is listed
```

Back up the keystore file and its password offline. Put the account name in your local `.env`: `FOUNDRY_ACCOUNT=arcdraw-deployer`.

## 3. Deploy the contracts [SPENDS]

`Deploy.s.sol` uses the canonical CREATE2 deployer with salt `keccak256("arcdraw.v1")`, so the addresses are deterministic. It skips contracts that are already deployed, so it is safe to rerun.

```bash
cd contracts
forge build
# 3a. Simulation against mainnet state (no --broadcast: nothing is sent)
forge script script/Deploy.s.sol --rpc-url arc_mainnet --account arcdraw-deployer
# 3b. Real deployment
forge script script/Deploy.s.sol --rpc-url arc_mainnet --account arcdraw-deployer --broadcast
```

Expected output of the 3a simulation, computed from the committed bytecode in a read-only run on 2026-09-17:

| Contract | Expected address |
|---|---|
| ArcDrawCoordinator | `0x2bA3B73a27B81b5e952E5e7E504CBDC329e8F89B` |
| FairAllocation | `0x719f2aFe0E2709ff17Cdf16065dcd35D448a8D8C` |

If 3a prints different addresses, the bytecode changed (a source edit or a different solc). That is fine, but use the printed addresses from here on.

Post-deploy sanity checks (read-only):

```bash
export RPC=https://rpc.mainnet.arc.io COORD=0x2bA3B73a27B81b5e952E5e7E504CBDC329e8F89B FA=0x719f2aFe0E2709ff17Cdf16065dcd35D448a8D8C
cast call $COORD "USDC()(address)" --rpc-url $RPC                 # 0x3600000000000000000000000000000000000000
cast call $COORD "currentRound()(uint64)" --rpc-url $RPC          # matches https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/latest (±1)
cast call $FA "coordinator()(address)" --rpc-url $RPC             # == $COORD
```

## 4. Verify the source on explorer.arc.io

explorer.arc.io runs Blockscout. The compiler settings come from `contracts/foundry.toml` (solc 0.8.30, osaka, optimizer 10,000 runs). The BLS library is internal, so no linking is needed.

```bash
cd contracts
forge verify-contract $COORD src/ArcDrawCoordinator.sol:ArcDrawCoordinator \
  --chain-id 5042 --verifier blockscout --verifier-url https://explorer.arc.io/api/ \
  --constructor-args $(cast abi-encode "constructor(address)" 0x3600000000000000000000000000000000000000) --watch
forge verify-contract $FA src/demo/FairAllocation.sol:FairAllocation \
  --chain-id 5042 --verifier blockscout --verifier-url https://explorer.arc.io/api/ \
  --constructor-args $(cast abi-encode "constructor(address)" $COORD) --watch
```

Check that `https://explorer.arc.io/address/$COORD` shows a **Contract** tab with the source. If the API call fails, use the explorer's manual verification page with "Standard JSON input" (`forge verify-contract … --show-standard-json-input > coordinator.json`).
UNKNOWN: the mainnet verifier URL is taken from the testnet docs pattern (`https://explorer.testnet.arc.io/api/`). If `/api/` fails, try `https://explorer.arc.io/api`.

## 5. Record the deployment

```bash
cd <repo root>
node contracts/script/write-deployment.mjs --chain 5042     # reads contracts/broadcast/Deploy.s.sol/5042/run-latest.json, no RPC, no keys
pnpm --filter @arcdraw/sdk deployments                      # regenerates packages/sdk/src/generated/deployments.ts
pnpm run verify                                             # drift checks + tests still green
```

Then edit `deployments/arc-mainnet.json` by hand:
- set `contracts.*.verified` to `true` once step 4 succeeds;
- fill `proofs.*` in step 8.

Commit `deployments/arc-mainnet.json`, `packages/sdk/src/generated/deployments.ts` and `contracts/broadcast/Deploy.s.sol/5042/run-latest.json` (contains no secrets; `contracts/cache/` is gitignored).

## 6. Build and host the website

The site is a static export. It reads `deployments/arc-mainnet.json` and `docs/*.md` **at build time**, so rebuild after step 5.

```bash
NEXT_PUBLIC_REPO_URL=https://github.com/<you>/arcdraw NEXT_PUBLIC_SITE_URL=https://<your-domain> pnpm build
npx serve apps/web/out     # local smoke test: /, /app/, /r/?id=1, /allocation/, /docs/
```

**Vercel**

| Setting | Value |
|---|---|
| Root Directory | `apps/web` (keep "Include files outside the root directory" enabled, which is the default) |
| Install Command | `pnpm install --frozen-lockfile` |
| Build Command | `cd ../.. && pnpm --filter "@arcdraw/web..." build` (builds the SDK first, then the site) |
| Output Directory | `out` |
| Env vars | `NEXT_PUBLIC_REPO_URL`, `NEXT_PUBLIC_SITE_URL`; optional `NEXT_PUBLIC_ARC_RPC_URL`, `NEXT_PUBLIC_COORDINATOR_ADDRESS`, `NEXT_PUBLIC_FAIR_ALLOCATION_ADDRESS` |
| Node | 22.x or newer |

**Any static host** (Cloudflare Pages, Netlify, GitHub Pages, S3): run `pnpm build`, then upload `apps/web/out/`. Routes use trailing slashes (`/app/`) and query strings (`/r/?id=N`), so no rewrites are needed.

Smoke test the live URL:
- the landing beacon shows "verified in your browser";
- `/app/` shows the coordinator address, not "Not deployed yet".

## 7. Run the relayer [SPENDS]

Create a **dedicated** hot wallet in your wallet software, fund it with about 1 USDC (step 1), and write its key only into `.env` on the relayer host:

```bash
cp .env.example .env && chmod 600 .env
# edit .env:
#   COORDINATOR_ADDRESS=<coordinator>          COORDINATOR_DEPLOY_BLOCK=<deployBlock from deployments/arc-mainnet.json>
#   RELAYER_PRIVATE_KEY=<relayer hot wallet key>   RELAYER_HEALTH_PORT=8787   RELAYER_MIN_BOUNTY=0
pnpm build
pnpm relayer:dry-run            # first: simulate only, confirm "relayer_started" and ticking logs, then Ctrl-C
pnpm relayer                    # live
curl -s localhost:8787/healthz  # 200 while ticking
```

For long-running hosting (Mac mini or a VPS), pick one:
- **Docker:**
  ```bash
  docker build -f services/relayer/Dockerfile -t arcdraw-relayer .
  docker run -d --restart unless-stopped --env-file .env -p 8787:8787 -v arcdraw-state:/data arcdraw-relayer
  ```
  The Docker build was not exercised in CI, so run it once locally first.
- **Plain Node under a supervisor** (launchd, systemd, pm2) running `pnpm relayer` with restart-on-exit. The process exits 1 after 5 failed ticks in a row, and exits 2 on bad config.

The logs are JSON lines. Use `txHash`, `requestIds` and `latency_ms` to fill step 8.
There is no separate keeper or indexer: the relayer is the keeper, and its log cursor (`RELAYER_STATE_FILE`) is the indexer.

## 8. On-chain proof scenario [SPENDS]

This covers PRD section 6 and SPEC section 12. Record every hash in `deployments/arc-mainnet.json` → `proofs` and in the README "Mainnet proof" table.

```bash
export RPC=https://rpc.mainnet.arc.io USDC=0x3600000000000000000000000000000000000000
export COORD=<coordinator> FA=<fairAllocation> ACCT=arcdraw-deployer
```

### 8a. EOA request, relayer fulfills (`requestTx`, `fulfillTx`)

The relayer must be running.

```bash
cast send $COORD "requestRandomness(uint32,uint96)" 0 0 --rpc-url $RPC --account $ACCT      # -> requestTx
ID=$(cast call $COORD "requestCount()(uint256)" --rpc-url $RPC); echo $ID
sleep 15
cast call $COORD "getRequest(uint256)((address,uint64,uint32,uint8,uint96,uint64,bytes32))" $ID --rpc-url $RPC
# status (4th field) == 3 (Fulfilled). The fulfill tx hash is in the relayer log (msg "fulfilled", txHash) or on /r/?id=$ID
```

### 8b. Two requests on one round, one `fulfillBatch` (`fulfillBatchTx`)

```bash
R=$(( $(cast call $COORD "minRequestRound()(uint64)" --rpc-url $RPC | cut -d" " -f1) + 20 ))   # ~60s ahead
cast send $COORD "requestRandomnessAtRound(uint64,uint32,uint96)" $R 0 0 --rpc-url $RPC --account $ACCT
cast send $COORD "requestRandomnessAtRound(uint64,uint32,uint96)" $R 0 0 --rpc-url $RPC --account $ACCT
# after ~70s the relayer sends ONE fulfillBatch for round $R with both ids (see the log line with requestIds [a,b])
```

### 8c. Bounty request, refund after the timeout, then a late fulfill (`refundTx`, `lateFulfillTx`)

```bash
# stop the relayer first
cast send $USDC "approve(address,uint256)" $COORD 10000 --rpc-url $RPC --account $ACCT          # 0.01 USDC
cast send $COORD "requestRandomness(uint32,uint96)" 0 10000 --rpc-url $RPC --account $ACCT
ID=$(cast call $COORD "requestCount()(uint256)" --rpc-url $RPC)
cast call $COORD "expiresAt(uint256)(uint64)" $ID --rpc-url $RPC       # unix time; wait until it has passed (~1h)
cast send $COORD "refund(uint256)" $ID --rpc-url $RPC --account $ACCT                           # -> refundTx
# restart the relayer (RELAYER_MIN_BOUNTY=0): it fulfills the refunded request   -> lateFulfillTx
# or click "Fulfill it yourself" on /r/?id=$ID
```

### 8d. FairAllocation: callback, finalize, loser refund (`fairAllocationDrawTx`, `callbackTx`, …)

Easiest from the web app at `/allocation/`, with 5 wallets (for example 5 accounts in one browser wallet, each holding 0.3 USDC):

1. **Create the sale** (deployer or any wallet):
   - treasury = your address;
   - price 0.1 USDC;
   - slots **3**;
   - subscribe deadline about 5 minutes out;
   - bounty 0.01 USDC.
2. **Subscribe** from 5 different accounts. Each account signs one permit.
3. **Draw** after the deadline. → `fairAllocationDrawTx`
4. **Fulfill.** The relayer fulfills and the FairAllocation callback stores the seed. → `callbackTx`: the fulfill tx whose `RandomnessFulfilled` event has `callbackSuccess = true`.
5. **Finalize.** This picks 3 winners and pays the treasury 0.3 USDC. → `fairAllocationFinalizeTx`
6. **Claim a refund** from one of the 2 losing accounts. → `fairAllocationRefundTx`

The minimum, if you have fewer wallets: slots 1 and 2 subscribers.

### 8e. Record

```bash
cast receipt <txHash> gasUsed --rpc-url $RPC      # fill proofs.measuredGas.{requestRandomness,fulfillFirstInRound,fulfillVerifiedRound}
```

Update:
- `deployments/arc-mainnet.json` → `proofs`;
- the README "Mainnet proof" table and `[MAINNET_MEASURED_GAS]`;
- the placeholders `[LIVE_URL]`, `[REPO_URL]` and `[COORDINATOR_ADDRESS]` in README.md and SUBMISSION.md.

Then:

```bash
pnpm build        # rebuild the site with the recorded proofs
```

Commit, push and redeploy the site.

**DoD:** every hash in the table opens on explorer.arc.io, the site's `/r/?id=<8a id>` passes all 3 checks, and `/allocation/` shows the finalized sale with its winners.

## Rollback / failure modes

| Problem | Action |
|---|---|
| Deploy tx reverted or got stuck | Rerun 3b. CREATE2 skips anything already deployed; nothing to roll back (no owner, no state) |
| Bug found after deploy | The contracts are immutable. Change the salt (`ARCDRAW_SALT=0x…`), redeploy, rerun step 5 and rebuild the site. Old requests stay refundable |
| Relayer wallet drained or key leaked | Stop the relayer, create a new hot wallet, update `.env`. Requests are not lost: anyone can fulfill later with the same outcome |
| Verification fails | Use the manual Standard JSON input. Verification does not block the proof |
| drand HTTP relays down | The relayer retries across `DRAND_URLS`, and requests stay pending (refundable after 1h) |
