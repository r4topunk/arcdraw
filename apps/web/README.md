# @arcdraw/web

ArcDraw website: landing page, docs rendered from the repo, a live app and the FairAllocation demo.
Next.js (App Router, static export) + Tailwind v4 + shadcn/ui-style components + wagmi/viem (injected wallet only).

## TL;DR

```bash
pnpm install
pnpm --filter @arcdraw/web dev        # http://localhost:3000
pnpm --filter @arcdraw/web build      # static site in apps/web/out
pnpm --filter @arcdraw/web typecheck
pnpm --filter @arcdraw/web abis       # refresh src/generated/abis.ts after forge build
```

## Routes

| Route | What |
|---|---|
| `/` | Landing: positioning, live drand beacon verified in the browser, how it works, why Arc, gas table parsed from `docs/GAS.md`, trust model, credits |
| `/docs/` | `integration` and `faq` (from `apps/web/content/`), `spec`, `gas`, `prd` (from `docs/`), rendered at build time |
| `/app/` | Request randomness (optional USDC bounty with approve), recent requests, "fulfill it yourself", refund |
| `/r/?id=N` | Inspector: status, round, txs (chunked `eth_getLogs` near the request time), BLS check with @noble/curves, derived randomness recomputed |
| `/allocation/` | FairAllocation: create sale, subscribe with an EIP-2612 permit, draw, fulfill, finalize, claim refund |

Query parameters instead of dynamic segments keep the site fully static (`output: "export"`).

## Configuration

Addresses come from `deployments/arc-mainnet.json` at build time. With empty addresses the app pages show a "Not deployed yet" state.
Optional build-time overrides:

| Variable | Default |
|---|---|
| `NEXT_PUBLIC_ARC_RPC_URL` | `https://rpc.mainnet.arc.io` |
| `NEXT_PUBLIC_COORDINATOR_ADDRESS` | from deployments JSON |
| `NEXT_PUBLIC_FAIR_ALLOCATION_ADDRESS` | from deployments JSON |
| `NEXT_PUBLIC_REPO_URL` | `https://github.com/r4topunk/arcdraw` (update when the repo is public) |
| `NEXT_PUBLIC_SITE_URL` | `https://arcdraw.xyz` (used for OG metadata) |

## Local end-to-end check (no mainnet transactions)

```bash
anvil --fork-url https://rpc.mainnet.arc.io --chain-id 5042 --hardfork osaka
# deploy locally with an unlocked anvil account: forge create ... --unlocked --from <anvil account> --broadcast
NEXT_PUBLIC_ARC_RPC_URL=http://127.0.0.1:8545 \
NEXT_PUBLIC_COORDINATOR_ADDRESS=0x... NEXT_PUBLIC_FAIR_ALLOCATION_ADDRESS=0x... pnpm dev
```

## Notes

- No analytics, trackers or cookies. External requests go only to the Arc RPC, the drand HTTP API (`api.drand.sh`, `api2.drand.sh`, `drand.cloudflare.com`) and the connected wallet.
- USDC is always handled through the ERC-20 at `0x3600...0000` with 6 decimals (`src/lib/format.ts`).
- Contract errors are mapped to plain-language messages in `src/lib/errors.ts`.
- Credits: drand / League of Entropy (quicknet), randa-mu/bls-solidity (MIT), Arc by Circle.
