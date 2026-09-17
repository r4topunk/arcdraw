import { ArrowRight, BookOpen, GitBranch } from "lucide-react";
import Link from "next/link";
import { CodeBlock } from "@/components/code";
import { HowItWorks } from "@/components/how-it-works";
import { LiveBeacon } from "@/components/live-beacon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { readGasTable } from "@/lib/docs";
import { deployments, isDeployed } from "@/lib/deployments";
import { explorerAddress } from "@/lib/chain";
import { site } from "@/lib/site";

const consumer = `import {ArcDrawConsumer} from "arcdraw/ArcDrawConsumer.sol";
import {IArcDrawCoordinator} from "arcdraw/interfaces/IArcDrawCoordinator.sol";

contract CommitteeDraw is ArcDrawConsumer {
    mapping(uint256 => bytes32) public seedOf;

    constructor(IArcDrawCoordinator c) ArcDrawConsumer(c) {}

    function draw() external returns (uint256 id) {
        // 60k gas for the callback, no bounty: relayers fulfill for free
        (id, ) = coordinator.requestRandomness(60_000, 0);
    }

    function _fulfillRandomness(uint256 id, bytes32 randomness) internal override {
        seedOf[id] = randomness; // keep it cheap, do the heavy work later
    }
}`;

const gasPick: { key: string; label: string }[] = [
  { key: "requestRandomness_noBounty", label: "Request, no bounty" },
  { key: "requestRandomness_bounty", label: "Request with USDC bounty" },
  { key: "fulfill_freshRound_bounty_noCallback", label: "Fulfill, fresh round (BLS verify)" },
  { key: "fulfill_verifiedRound_bounty_noCallback", label: "Fulfill, round already verified" },
  { key: "fulfillBatch_freshRound_5ids_bounty_noCallback", label: "Batch fulfill, 5 requests" },
  { key: "refund_bounty", label: "Refund after timeout" },
];

const whyArc = [
  { k: "PREVRANDAO = 0", v: "Arc exposes no onchain entropy, and no VRF provider is live yet. Every fair draw needs an external source." },
  { k: "EIP-2537", v: "BLS12-381 precompiles at 0x0b–0x11 make a full drand signature check affordable onchain." },
  { k: "USDC gas", v: "Costs and bounties are in the same stable unit. A fresh-round verification is under a cent." },
  { k: "~0.5s finality", v: "Deterministic finality means consumers never see a reorged random value. Latency is the 4-round safety delay plus one block." },
];

const trust = [
  { who: "drand League of Entropy", can: "Bias or predict rounds only if a threshold of independent operators colludes", cannot: "—" },
  { who: "Requester", can: "Choose the round (≥ current + 4) and callback gas", cannot: "See the outcome first, or reroll by refunding" },
  { who: "Relayer / fulfiller", can: "Delay delivery, race for the bounty", cannot: "Forge randomness, starve or revert your callback" },
  { who: "Deployer", can: "Nothing after deployment", cannot: "Upgrade, pause or change the drand key" },
];

export default function Home() {
  const gas = readGasTable();
  const gasRows = gasPick
    .map((p) => ({ ...p, row: gas.find((g) => g.scenario === p.key) }))
    .filter((p): p is typeof p & { row: NonNullable<typeof p.row> } => Boolean(p.row));
  const maxGas = Math.max(...gasRows.map((g) => g.row.gas));

  return (
    <>
      {/* Hero */}
      <section className="relative border-b">
        <div className="bg-grid pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_bottom,black,transparent)]" aria-hidden />
        <div className="relative mx-auto grid max-w-6xl gap-10 px-4 pb-16 pt-12 sm:pt-20 lg:grid-cols-[1.15fr_1fr] lg:items-center lg:gap-14 lg:pb-24">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="signal">Arc mainnet · chain 5042</Badge>
              <Badge>{isDeployed ? "Live" : "Deploying soon"}</Badge>
              <Badge variant="warn">Experimental · unaudited</Badge>
            </div>
            <h1 className="text-display mt-6 text-[2.75rem] font-bold leading-[0.95] sm:text-6xl lg:text-7xl">
              Randomness
              <br />
              Arc can <span className="relative whitespace-nowrap text-signal-ink">verify<span className="text-foreground">.</span></span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
              ArcDraw pins a future <strong className="font-semibold text-foreground">drand quicknet</strong> round for every request and
              checks the League of Entropy BLS signature <strong className="font-semibold text-foreground">onchain</strong>. No oracle
              operator, no admin key, no subscription. Anyone can deliver the result and earn a USDC bounty.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg" variant="signal">
                <Link href="/app/">
                  Request randomness <ArrowRight aria-hidden />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link href="/docs/integration/">
                  <BookOpen aria-hidden /> Integrate in 10 lines
                </Link>
              </Button>
            </div>
            <dl className="mt-10 grid max-w-lg grid-cols-3 gap-4 border-t pt-6">
              <div>
                <dt className="text-xs text-muted-foreground">Fulfill, fresh round</dt>
                <dd className="text-display tabular mt-1 text-lg font-semibold sm:text-2xl">0.006 USDC</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Fulfill, reused round</dt>
                <dd className="text-display tabular mt-1 text-lg font-semibold sm:text-2xl">0.0015 USDC</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Request → result</dt>
                <dd className="text-display tabular mt-1 text-lg font-semibold sm:text-2xl">~10–15s</dd>
              </div>
            </dl>
          </div>
          <LiveBeacon />
        </div>
      </section>

      {/* Problem */}
      <section className="mx-auto max-w-6xl px-4 py-20">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <p className="font-mono text-xs uppercase tracking-widest text-signal-ink">The gap</p>
            <h2 className="text-display mt-3 text-4xl font-semibold leading-tight sm:text-5xl">
              Fair draws need entropy nobody controls.
            </h2>
          </div>
          <div className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2">
            {[
              ["block.prevrandao", "Always 0 on Arc. Useless as a seed."],
              ["blockhash", "Known to the block producer before anyone else."],
              ["commit-reveal", "Every party must stay online; the last revealer can walk away."],
              ["offchain server", "\"Trust us\" randomness nobody can audit afterwards."],
            ].map(([k, v]) => (
              <div key={k} className="bg-card p-5">
                <p className="font-mono text-sm line-through decoration-signal decoration-2">{k}</p>
                <p className="mt-2 text-sm text-muted-foreground">{v}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="border-y bg-card/50">
        <div className="mx-auto max-w-6xl px-4 py-20">
          <p className="font-mono text-xs uppercase tracking-widest text-signal-ink">How it works</p>
          <h2 className="text-display mt-3 max-w-2xl text-4xl font-semibold leading-tight">
            One request, one future round, one pairing check.
          </h2>
          <div className="mt-12">
            <HowItWorks />
          </div>
          <p className="mt-10 max-w-3xl text-sm text-muted-foreground">
            The round is fixed when the request is created, so the outcome is fixed too. A refund after the 1-hour timeout only returns
            the bounty: the request stays fulfillable, so nobody can cancel an unfavourable draw and try again.
          </p>
        </div>
      </section>

      {/* Code + Why Arc */}
      <section className="mx-auto grid max-w-6xl gap-12 px-4 py-20 lg:grid-cols-2">
        <div className="min-w-0">
          <p className="font-mono text-xs uppercase tracking-widest text-signal-ink">For Solidity developers</p>
          <h2 className="text-display mt-3 text-3xl font-semibold">Inherit, request, receive.</h2>
          <p className="mt-3 text-muted-foreground">
            Freeze your inputs, request, store the seed in the callback. The coordinator guarantees the callback gets the gas you asked
            for and that a reverting callback never blocks delivery.
          </p>
          <CodeBlock className="mt-6" title="CommitteeDraw.sol" code={consumer} />
        </div>
        <div className="min-w-0">
          <p className="font-mono text-xs uppercase tracking-widest text-signal-ink">Why Arc</p>
          <h2 className="text-display mt-3 text-3xl font-semibold">Built for how Arc actually works.</h2>
          <dl className="mt-6 divide-y border-y">
            {whyArc.map((w) => (
              <div key={w.k} className="grid gap-1 py-4 sm:grid-cols-[9rem_1fr] sm:gap-6">
                <dt className="font-mono text-sm font-semibold">{w.k}</dt>
                <dd className="text-sm text-muted-foreground">{w.v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* Gas */}
      <section className="border-y bg-card/50">
        <div className="mx-auto max-w-6xl px-4 py-20">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="font-mono text-xs uppercase tracking-widest text-signal-ink">Measured, not estimated</p>
              <h2 className="text-display mt-3 text-3xl font-semibold sm:text-4xl">What it costs at Arc&apos;s 20 gwei floor</h2>
            </div>
            <Link href="/docs/gas/" className="text-sm text-signal-ink underline underline-offset-4">
              Full gas report
            </Link>
          </div>
          <div className="mt-10 overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <caption className="sr-only">Gas and USDC cost per ArcDraw call, isolated transactions with real quicknet signatures</caption>
              <thead>
                <tr className="border-b border-foreground text-left">
                  <th scope="col" className="py-2 pr-4 font-medium">Call</th>
                  <th scope="col" className="w-2/5 py-2 pr-4 font-medium"><span className="sr-only">Relative gas</span></th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">Gas</th>
                  <th scope="col" className="py-2 text-right font-medium">USDC</th>
                </tr>
              </thead>
              <tbody>
                {gasRows.map((g) => (
                  <tr key={g.key} className="border-b">
                    <th scope="row" className="py-3 pr-4 text-left font-normal">{g.label}</th>
                    <td className="py-3 pr-4" aria-hidden>
                      <div className="h-2 rounded-full bg-muted">
                        <div className="h-2 rounded-full bg-signal" style={{ width: `${(g.row.gas / maxGas) * 100}%` }} />
                      </div>
                    </td>
                    <td className="tabular py-3 pr-4 text-right font-mono">{g.row.gas.toLocaleString("en-US")}</td>
                    <td className="tabular py-3 text-right font-mono">{g.row.usdc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Source: docs/GAS.md, generated by forge with isolated transactions (cold storage, intrinsic gas, calldata). Several
            requests on the same round share one BLS verification.
          </p>
        </div>
      </section>

      {/* Demo + trust */}
      <section className="mx-auto grid max-w-6xl gap-12 px-4 py-20 lg:grid-cols-[1fr_1.2fr]">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-signal-ink">Demo: FairAllocation</p>
          <h2 className="text-display mt-3 text-3xl font-semibold">An oversubscribed USDC sale, settled fairly.</h2>
          <p className="mt-3 text-muted-foreground">
            K slots, N &gt; K subscribers who each deposit the slot price. After the deadline anyone triggers the draw. A partial
            Fisher-Yates shuffle over the drand seed picks a uniform K-subset, the treasury receives K × price and every loser pulls a
            full refund. Think RWA pre-sale, capped vault, grant round. Not a casino.
          </p>
          <Button asChild className="mt-6" variant="outline">
            <Link href="/allocation/">
              Open the demo <ArrowRight aria-hidden />
            </Link>
          </Button>
        </div>
        <div className="min-w-0">
          <p className="font-mono text-xs uppercase tracking-widest text-signal-ink">Trust model</p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm">
              <thead>
                <tr className="border-b border-foreground text-left">
                  <th scope="col" className="py-2 pr-4 font-medium">Actor</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Can</th>
                  <th scope="col" className="py-2 font-medium">Cannot</th>
                </tr>
              </thead>
              <tbody>
                {trust.map((t) => (
                  <tr key={t.who} className="border-b align-top">
                    <th scope="row" className="py-3 pr-4 text-left font-medium">{t.who}</th>
                    <td className="py-3 pr-4 text-muted-foreground">{t.can}</td>
                    <td className="py-3 text-muted-foreground">{t.cannot}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Open source + credits */}
      <section className="mx-auto max-w-6xl px-4">
        <div className="relative overflow-hidden rounded-xl bg-primary p-8 text-primary-foreground sm:p-12">
          <div className="grid gap-10 lg:grid-cols-[1.2fr_1fr]">
            <div>
              <p className="font-mono text-xs uppercase tracking-widest opacity-70">Open source · MIT</p>
              <h2 className="text-display mt-3 text-3xl font-semibold sm:text-4xl">Standing on public goods.</h2>
              <p className="mt-4 max-w-lg opacity-80">
                ArcDraw is a thin, immutable coordinator. The hard parts come from projects that deserve the credit.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Button asChild variant="signal">
                  <a href={site.repoUrl} target="_blank" rel="noreferrer">
                    <GitBranch aria-hidden /> Source code
                  </a>
                </Button>
                {isDeployed && deployments.coordinator && (
                  <Button asChild variant="outline" className="border-primary-foreground/30 bg-transparent text-primary-foreground hover:bg-primary-foreground/10">
                    <a href={explorerAddress(deployments.coordinator)} target="_blank" rel="noreferrer">
                      Coordinator on explorer
                    </a>
                  </Button>
                )}
              </div>
            </div>
            <ul className="grid gap-5 text-sm">
              <li>
                <a className="font-semibold underline-offset-4 hover:underline" href="https://drand.love" target="_blank" rel="noreferrer">
                  drand · League of Entropy
                </a>
                <p className="mt-1 opacity-75">The quicknet beacon: threshold BLS signatures every 3 seconds from independent operators.</p>
              </li>
              <li>
                <a className="font-semibold underline-offset-4 hover:underline" href="https://github.com/randa-mu/bls-solidity" target="_blank" rel="noreferrer">
                  randa-mu/bls-solidity (MIT)
                </a>
                <p className="mt-1 opacity-75">BLS12-381 hash-to-curve and verification on EIP-2537, vendored at a pinned commit.</p>
              </li>
              <li>
                <a className="font-semibold underline-offset-4 hover:underline" href="https://docs.arc.io" target="_blank" rel="noreferrer">
                  Arc by Circle
                </a>
                <p className="mt-1 opacity-75">The Osaka EVM with BLS precompiles, USDC gas and deterministic finality.</p>
              </li>
            </ul>
          </div>
        </div>
      </section>
    </>
  );
}
