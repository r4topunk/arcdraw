# CHECKLIST: human-only steps, in order

Agents can't do these steps: they need keys, money, accounts or publishing. Details for each step are in [DEPLOY.md](DEPLOY.md).
DoD for the whole list: a live URL, a public repo and proof txs on explorer.arc.io, all pasted into DoraHacks.

| # | Step | Needs | Done when | Ref |
|---|---|---|---|---|
| 1 | Run `pnpm install && pnpm run verify` on a clean clone | Machine | Exit 0 | DEPLOY §0 |
| 2 | Create the Foundry keystore `arcdraw-deployer` and back it up offline | Password | `cast wallet list` shows it | DEPLOY §2 |
| 3 | Acquire about 5 USDC on Arc mainnet (bridge or exchange). Fund the deployer (1.5), relayer (1.0) and 5 demo accounts (0.3 each) | USDC, wallet | Balances visible with `cast balance` | DEPLOY §1 |
| 4 | Create a dedicated relayer hot wallet. Put its key only into `.env` (chmod 600) | Wallet app | Key is in `.env` (chmod 600) and the relayer wallet is funded (`cast balance`) | DEPLOY §7 |
| 5 | Simulate the deploy, then deploy with `--broadcast` **[SPENDS]** | Keystore password | Two addresses printed. Expected: `0x7E91…C563` and `0x16A0…2067` | DEPLOY §3 |
| 6 | Verify both contracts on explorer.arc.io | n/a | A "Contract" tab shows the source | DEPLOY §4 |
| 7 | `write-deployment.mjs`, then `pnpm --filter @arcdraw/sdk deployments`, `verified: true`, `pnpm run verify`, then `pnpm relayer:dry-run` | n/a | JSON has the addresses and deploy blocks, the build is green and the dry-run relayer ticks | DEPLOY §5, §7 |
| 8 | Create the public GitHub repo, then commit and push. Check that `git ls-files` includes no `.env` | GitHub account | Repo URL opens | n/a |
| 9 | Host the website (Vercel or a static host) with `NEXT_PUBLIC_REPO_URL`, `NEXT_PUBLIC_SITE_URL` and `REQUIRE_SITE_ENV=true` set | Hosting account, optional domain | Live `/app/` shows the coordinator. The landing beacon is verified | DEPLOY §6 |
| 10 | Start the relayer live (Docker or a supervisor) **[SPENDS]** | Host | `/healthz` returns 200 | DEPLOY §7 |
| 11 | Proof 8a: EOA request fulfilled by the relayer **[SPENDS]** | Deployer | Status Fulfilled, 2 hashes noted | DEPLOY §8a |
| 12 | Proof 8b: two requests on one round, then one `fulfillBatch` **[SPENDS]** | Deployer | One batch tx with 2 ids | DEPLOY §8b |
| 13 | Proof 8c: stop the relayer, request with a bounty, wait 1h, refund, restart the relayer for the late fulfill **[SPENDS]** | Deployer, 1h wait | Refund and late fulfill hashes | DEPLOY §8c |
| 14 | Proof 8d: FairAllocation with 3 slots and 5 subscribers: draw, callback, finalize, loser refund **[SPENDS]** | 5 accounts | Sale finalized, refund claimed | DEPLOY §8d |
| 15 | Record the hashes and gas in `deployments/arc-mainnet.json` and the README. Replace `[LIVE_URL]`, `[REPO_URL]`, `[REPO_OWNER]` and the address placeholders. Rebuild, push, redeploy the site | n/a | No placeholders left: `grep -n "\[[A-Z_]*\]" README.md SUBMISSION.md apps/web/content/*.md` is empty, and `grep -rn "r4topunk/arcdraw\|arcdraw.xyz" apps/web/src` only matches fallbacks you actually own | DEPLOY §8e |
| 16 | Record the 2-minute demo video from the script and upload it (YouTube unlisted or Loom) | Screen recorder | Video URL | SUBMISSION |
| 17 | Submit the BUIDL on DoraHacks Arc Microgrants: paste the fields from SUBMISSION.md, plus your GitHub/X/Farcaster profile | DoraHacks account | Submission visible, before 2026-10-14 23:59 ET | SUBMISSION |
| 18 | Keep the relayer running through the review window (decisions by 2026-10-21). Watch `/healthz` and the relayer wallet balance | Host | Organic requests keep getting fulfilled | PRD §6 |

Optional after submitting: publish `@arcdraw/sdk` to npm (`pnpm --filter @arcdraw/sdk publish --access public`, requires an npm account).

UNKNOWN:
- Which exchanges support direct withdrawals to Arc mainnet.
- Whether the Blockscout API path on mainnet is exactly `https://explorer.arc.io/api/`.
- Real relayer latency and bounty-transfer gas on Arc's USDC. These are measured in steps 11–14.
