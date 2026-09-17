"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { isAddress, parseEventLogs, parseSignature, type Address } from "viem";
import { useConnection, useReadContracts, useWalletClient } from "wagmi";
import { FulfillButton } from "@/components/request-actions";
import { AddressLink, NotDeployed, TxStatus, useTx, WalletGate } from "@/components/web3";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { arcMainnet, USDC_ADDRESS } from "@/lib/chain";
import { arcDrawCoordinatorAbi, DRAW_TIMEOUT_S, fairAllocationFullAbi, SALE_PHASE, usdcAbi, type SalePhase } from "@/lib/contracts";
import { deployments } from "@/lib/deployments";
import { roundTime } from "@/lib/drand";
import { explainError } from "@/lib/errors";
import { formatDuration, formatInt, formatTime, formatUsdc, parseUsdc } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

const phaseOf = (n: number): SalePhase => SALE_PHASE[n] ?? "None";

function PhaseBadge({ phase }: { phase: SalePhase }) {
  const v = phase === "Open" ? "signal" : phase === "Finalized" ? "ok" : phase === "None" ? "default" : "warn";
  return <Badge variant={v}>{phase}</Badge>;
}

export function AllocationApp() {
  const fair = deployments.fairAllocation;
  const coordinator = deployments.coordinator;
  const params = useSearchParams();
  const raw = params.get("sale") ?? "";
  const saleId = /^\d+$/.test(raw) && raw !== "0" ? BigInt(raw) : null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:py-14">
      <p className="font-mono text-xs uppercase tracking-widest text-signal-ink">Demo consumer · FairAllocation</p>
      <h1 className="text-display mt-2 max-w-3xl text-4xl font-bold sm:text-5xl">Oversubscribed sale, settled by a public beacon</h1>
      <p className="mt-3 max-w-2xl text-muted-foreground">
        A creator offers K slots at a fixed USDC price. Anyone subscribes by depositing the price. If more than K people join, a
        drand-seeded shuffle picks exactly K winners; the treasury receives K × price and every other subscriber gets a full refund.
      </p>
      <ol className="mt-6 flex flex-wrap gap-2 text-xs" aria-label="Sale lifecycle">
        {["Create", "Subscribe", "Draw (after deadline)", "Fulfill", "Finalize", "Refund losers"].map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span className="rounded-full border bg-card px-2.5 py-1">
              <span className="mr-1.5 font-mono text-muted-foreground">{i + 1}</span>
              {s}
            </span>
            {i < 5 && <ArrowRight className="size-3 text-muted-foreground" aria-hidden />}
          </li>
        ))}
      </ol>
      <div className="mt-10">
        {!fair || !coordinator ? (
          <NotDeployed what="The FairAllocation demo" />
        ) : saleId ? (
          <SaleDetail fair={fair} coordinator={coordinator} saleId={saleId} />
        ) : (
          <div className="grid gap-8 lg:grid-cols-[minmax(0,24rem)_1fr]">
            <CreateSale fair={fair} />
            <SaleList fair={fair} />
          </div>
        )}
      </div>
    </div>
  );
}

function CreateSale({ fair }: { fair: Address }) {
  const { address } = useConnection();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [treasury, setTreasury] = useState("");
  const [price, setPrice] = useState("0.10");
  const [slots, setSlots] = useState("2");
  const [minutes, setMinutes] = useState("10");
  const [bountyIn, setBountyIn] = useState("0");
  const approveTx = useTx();
  const createTx = useTx();

  const treasuryAddr = treasury.trim() || address || "";
  const priceU = parseUsdc(price);
  const bounty = parseUsdc(bountyIn);
  const slotsN = /^\d+$/.test(slots) ? Number(slots) : 0;
  const minutesN = /^\d+$/.test(minutes) ? Number(minutes) : 0;
  const errors = {
    treasury: treasuryAddr && !isAddress(treasuryAddr) ? "Not a valid address." : null,
    price: priceU === null || priceU === 0n ? "Enter a price above 0 with up to 6 decimals." : null,
    slots: slotsN < 1 || slotsN > 1000 ? "Between 1 and 1000." : null,
    minutes: minutesN < 1 || minutesN > 60 * 24 * 30 ? "Between 1 minute and 30 days." : null,
    bounty: bounty === null ? "Up to 6 decimals." : null,
  };
  const invalid = Object.values(errors).some(Boolean) || !treasuryAddr;

  const allowance = useReadContracts({
    contracts: address
      ? [{ address: USDC_ADDRESS, abi: usdcAbi, functionName: "allowance", args: [address, fair], chainId: arcMainnet.id }]
      : [],
    query: { enabled: Boolean(address) },
  });
  const allowed = (allowance.data?.[0]?.result as bigint | undefined) ?? 0n;

  async function submit() {
    if (invalid || priceU === null || bounty === null) return;
    if (bounty > 0n && allowed < bounty) {
      const ok = await approveTx.run({
        label: `Approve ${formatUsdc(bounty)} bounty`,
        address: USDC_ADDRESS,
        abi: usdcAbi,
        functionName: "approve",
        args: [fair, bounty],
      });
      if (!ok) return;
    }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + minutesN * 60);
    const receipt = await createTx.run({
      label: "Create sale",
      address: fair,
      abi: fairAllocationFullAbi,
      functionName: "createSale",
      args: [treasuryAddr as Address, priceU, slotsN, deadline, bounty],
    });
    if (!receipt) return;
    await queryClient.invalidateQueries();
    const [evt] = parseEventLogs({ abi: fairAllocationFullAbi, logs: receipt.logs, eventName: "SaleCreated" });
    if (evt) router.push(`/allocation/?sale=${evt.args.saleId}`);
  }

  return (
    <Card className="self-start">
      <CardHeader>
        <CardTitle>Create a sale</CardTitle>
        <CardDescription>Use small amounts: this is a live mainnet demo with real USDC.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field id="treasury" label="Treasury" error={errors.treasury} help="Receives K × price. Defaults to your address.">
            <Input
              id="treasury"
              placeholder={address ?? "0x…"}
              value={treasury}
              onChange={(e) => setTreasury(e.target.value)}
              aria-invalid={Boolean(errors.treasury)}
              className="font-mono"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field id="price" label="Price per slot (USDC)" error={errors.price}>
              <Input id="price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-invalid={Boolean(errors.price)} />
            </Field>
            <Field id="slots" label="Slots (K)" error={errors.slots}>
              <Input id="slots" inputMode="numeric" value={slots} onChange={(e) => setSlots(e.target.value)} aria-invalid={Boolean(errors.slots)} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field id="minutes" label="Open for (minutes)" error={errors.minutes}>
              <Input id="minutes" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-invalid={Boolean(errors.minutes)} />
            </Field>
            <Field id="sbounty" label="Draw bounty (USDC)" error={errors.bounty}>
              <Input id="sbounty" inputMode="decimal" value={bountyIn} onChange={(e) => setBountyIn(e.target.value)} aria-invalid={Boolean(errors.bounty)} />
            </Field>
          </div>
          <WalletGate action="create a sale">
            <Button type="submit" variant="signal" disabled={invalid || approveTx.busy || createTx.busy}>
              {bounty !== null && bounty > 0n && allowed < bounty ? "Approve bounty, then create" : "Create sale"}
            </Button>
          </WalletGate>
          <TxStatus state={approveTx.state} />
          <TxStatus state={createTx.state} />
        </form>
      </CardContent>
    </Card>
  );
}

function Field({ id, label, error, help, children }: { id: string; label: string; error?: string | null; help?: string; children: React.ReactNode }) {
  return (
    <div className="grid content-start gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {(error || help) && <p className={cn("text-xs", error ? "text-danger" : "text-muted-foreground")}>{error ?? help}</p>}
    </div>
  );
}

function SaleList({ fair }: { fair: Address }) {
  const count = useReadContracts({
    contracts: [{ address: fair, abi: fairAllocationFullAbi, functionName: "saleCount", chainId: arcMainnet.id }],
    query: { refetchInterval: 6000 },
  });
  const n = count.data?.[0]?.result as bigint | undefined;
  const ids = useMemo(() => {
    const out: bigint[] = [];
    if (!n) return out;
    for (let i = n; i >= 1n && out.length < 12; i--) out.push(i);
    return out;
  }, [n]);
  const sales = useReadContracts({
    contracts: ids.flatMap((id) => [
      { address: fair, abi: fairAllocationFullAbi, functionName: "getSale" as const, args: [id] as const, chainId: arcMainnet.id },
      { address: fair, abi: fairAllocationFullAbi, functionName: "participantCount" as const, args: [id] as const, chainId: arcMainnet.id },
    ]),
    query: { enabled: ids.length > 0, refetchInterval: 6000 },
  });
  const now = useNow(1000);

  return (
    <section aria-labelledby="sales-title" className="min-w-0">
      <h2 id="sales-title" className="text-lg font-semibold">Recent sales</h2>
      {count.error && <Alert variant="danger" className="mt-4">{explainError(count.error)}</Alert>}
      {n === 0n && <p className="mt-4 rounded-md border border-dashed p-6 text-sm text-muted-foreground">No sales yet. Create the first one.</p>}
      <ul className="mt-4 grid gap-3">
        {ids.map((id, i) => {
          const s = sales.data?.[i * 2]?.result as SaleT | undefined;
          const participants = sales.data?.[i * 2 + 1]?.result as bigint | undefined;
          if (!s) return <li key={id.toString()} className="h-20 animate-pulse rounded-lg border bg-card" aria-hidden />;
          const phase = phaseOf(s.phase);
          return (
            <li key={id.toString()}>
              <Link href={`/allocation/?sale=${id}`} className="block rounded-lg border bg-card p-4 transition-colors hover:border-foreground/40">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-3">
                    <span className="text-display text-xl font-semibold">Sale #{id.toString()}</span>
                    <PhaseBadge phase={phase} />
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {phase === "Open" && now !== null
                      ? now < Number(s.subscribeDeadline)
                        ? `closes in ${formatDuration(Number(s.subscribeDeadline) - now)}`
                        : "subscriptions closed"
                      : null}
                  </span>
                </div>
                <OversubscriptionBar n={Number(participants ?? 0n)} k={s.slots} />
                <p className="mt-2 text-sm text-muted-foreground">
                  <span className="tabular font-mono text-foreground">{formatInt(participants ?? 0n)}</span> subscribers for{" "}
                  <span className="tabular font-mono text-foreground">{s.slots}</span> slots at{" "}
                  <span className="tabular font-mono text-foreground">{formatUsdc(s.pricePerSlot)}</span>
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type SaleT = {
  creator: Address;
  treasury: Address;
  pricePerSlot: bigint;
  slots: number;
  subscribeDeadline: bigint;
  bounty: bigint;
  phase: number;
  requestId: bigint;
  seed: `0x${string}`;
};

function OversubscriptionBar({ n, k }: { n: number; k: number }) {
  const total = Math.max(n, k, 1);
  return (
    <div className="mt-3 flex h-2 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={`${n} subscribers for ${k} slots`}>
      <div className="bg-foreground" style={{ width: `${(Math.min(n, k) / total) * 100}%` }} />
      {n > k && <div className="bg-signal" style={{ width: `${((n - k) / total) * 100}%` }} />}
      {n < k && <div className="bg-muted" style={{ width: `${((k - n) / total) * 100}%` }} />}
    </div>
  );
}

function SaleDetail({ fair, coordinator, saleId }: { fair: Address; coordinator: Address; saleId: bigint }) {
  const { address } = useConnection();
  const now = useNow(1000);
  const base = { address: fair, abi: fairAllocationFullAbi, chainId: arcMainnet.id } as const;
  const reads = useReadContracts({
    contracts: [
      { ...base, functionName: "getSale", args: [saleId] },
      { ...base, functionName: "participants", args: [saleId] },
      { ...base, functionName: "treasuryOwed", args: [saleId] },
      { ...base, functionName: "creatorOwed", args: [saleId] },
    ],
    query: { refetchInterval: 3000 },
  });
  const sale = reads.data?.[0]?.result as SaleT | undefined;
  const participants = (reads.data?.[1]?.result as readonly Address[] | undefined) ?? [];
  const treasuryOwed = (reads.data?.[2]?.result as bigint | undefined) ?? 0n;
  const creatorOwed = (reads.data?.[3]?.result as bigint | undefined) ?? 0n;
  const phase = sale ? phaseOf(sale.phase) : null;
  const settled = phase === "Finalized" || phase === "Cancelled";

  const winnerReads = useReadContracts({
    contracts:
      settled
        ? participants.flatMap((p) => [
            { ...base, functionName: "isWinner" as const, args: [saleId, p] as const },
            { ...base, functionName: "hasRefunded" as const, args: [saleId, p] as const },
          ])
        : [],
    query: { enabled: settled && participants.length > 0, refetchInterval: 6000 },
  });

  const request = useReadContracts({
    contracts: sale && sale.requestId > 0n ? [{ address: coordinator, abi: arcDrawCoordinatorAbi, functionName: "getRequest", args: [sale.requestId], chainId: arcMainnet.id }] : [],
    query: { enabled: Boolean(sale && sale.requestId > 0n), refetchInterval: 3000 },
  });
  const req = request.data?.[0]?.result;

  if (reads.error) return <Alert variant="danger">Could not read sale #{saleId.toString()}: {explainError(reads.error)}</Alert>;
  if (!sale) return <div className="h-72 animate-pulse rounded-lg border bg-card" aria-label="Loading sale" />;
  if (phase === "None") return <Alert variant="warn">Sale #{saleId.toString()} does not exist.</Alert>;

  const n = participants.length;
  const k = sale.slots;
  const deadline = Number(sale.subscribeDeadline);
  const open = now !== null && now < deadline;
  const me = address ? participants.findIndex((p) => p.toLowerCase() === address.toLowerCase()) : -1;
  const myWin = me >= 0 ? (winnerReads.data?.[me * 2]?.result as boolean | undefined) : undefined;
  const myRefunded = me >= 0 ? (winnerReads.data?.[me * 2 + 1]?.result as boolean | undefined) : undefined;
  const roundTs = req ? Number(roundTime(req.round)) : null;

  return (
    <div className="grid gap-8">
      <div>
        <Link href="/allocation/" className="text-sm text-muted-foreground hover:text-foreground">
          ← All sales
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h2 className="text-display text-3xl font-semibold">Sale #{saleId.toString()}</h2>
          <PhaseBadge phase={phase!} />
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_22rem]">
        <div className="grid min-w-0 content-start gap-6">
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
            <Cell label="Price per slot">{formatUsdc(sale.pricePerSlot)}</Cell>
            <Cell label="Slots (K)">{k}</Cell>
            <Cell label="Subscribers (N)">{n}</Cell>
            <Cell label="Deadline">
              <span className="font-sans text-sm">{formatTime(sale.subscribeDeadline)}</span>
            </Cell>
            <Cell label="Draw bounty">{formatUsdc(sale.bounty)}</Cell>
            <Cell label="Treasury"><AddressLink address={sale.treasury} /></Cell>
          </dl>
          <div>
            <OversubscriptionBar n={n} k={k} />
            <p className="mt-2 text-xs text-muted-foreground">
              {n > k ? `${n - k} more subscribers than slots: a draw decides.` : `${k - n} slots left. With N ≤ K everyone wins, no draw needed.`}
            </p>
          </div>

          <section aria-labelledby="ppl-title">
            <h3 id="ppl-title" className="font-semibold">Subscribers</h3>
            {n === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">Nobody yet.</p>
            ) : (
              <ol className="mt-3 grid gap-1.5 sm:grid-cols-2">
                {participants.map((p, i) => {
                  const win = winnerReads.data?.[i * 2]?.result as boolean | undefined;
                  const refunded = winnerReads.data?.[i * 2 + 1]?.result as boolean | undefined;
                  return (
                    <li key={p} className={cn("flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2 text-sm", win && "border-ok/50")}>
                      <span className="flex items-center gap-2">
                        <span className="tabular w-6 font-mono text-xs text-muted-foreground">{i}</span>
                        <AddressLink address={p} />
                        {i === me && <span className="text-xs text-muted-foreground">(you)</span>}
                      </span>
                      {phase === "Cancelled" && (refunded ? <Badge>Refunded</Badge> : refunded === false ? <Badge variant="warn">Refund due</Badge> : null)}
                      {phase === "Finalized" &&
                        (win ? <Badge variant="ok">Allocated</Badge> : refunded ? <Badge>Refunded</Badge> : win === false ? <Badge variant="warn">Refund due</Badge> : null)}
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </div>

        <aside className="grid content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Next step</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              {phase === "Open" && open && (
                <>
                  <p className="text-muted-foreground">
                    Subscriptions close in <strong className="tabular text-foreground">{formatDuration(deadline - (now ?? 0))}</strong>.
                    Deposit {formatUsdc(sale.pricePerSlot)} for one slot. Losers are refunded in full.
                  </p>
                  {me >= 0 ? <Alert variant="ok">You are subscribed.</Alert> : <Subscribe fair={fair} saleId={saleId} price={sale.pricePerSlot} />}
                </>
              )}
              {phase === "Open" && !open && n > k && (
                <>
                  <p className="text-muted-foreground">Oversubscribed and closed. Anyone can trigger the draw: it pins a drand round 3 to 6 seconds ahead.</p>
                  <SaleAction fair={fair} saleId={saleId} fn="draw" label="Draw winners" />
                </>
              )}
              {phase === "Open" && !open && n <= k && (
                <>
                  <p className="text-muted-foreground">Closed with N ≤ K. Every subscriber gets a slot, no randomness needed.</p>
                  <SaleAction fair={fair} saleId={saleId} fn="finalize" label="Finalize" />
                </>
              )}
              {phase === "Drawing" && req && (
                <>
                  <p className="text-muted-foreground">
                    Waiting for drand round <span className="tabular font-mono text-foreground">#{formatInt(req.round)}</span>
                    {roundTs !== null && now !== null && now < roundTs ? ` (out in ${formatDuration(roundTs - now)})` : " (published)"}. A relayer delivers it, or you can.
                  </p>
                  {req.status === 3 ? (
                    <>
                      <p className="text-muted-foreground">The request is fulfilled but the callback did not land. Copy the stored seed.</p>
                      <SaleAction fair={fair} saleId={saleId} fn="syncSeed" label="Sync seed" />
                    </>
                  ) : (
                    roundTs !== null &&
                    now !== null &&
                    now >= roundTs && (
                      <>
                        <FulfillButton coordinator={coordinator} requestId={sale.requestId} round={req.round} size="default" />
                        {now >= roundTs + DRAW_TIMEOUT_S && (
                          <>
                            <p className="text-muted-foreground">Nobody delivered the draw for 7 days. Cancelling refunds every subscriber.</p>
                            <SaleAction fair={fair} saleId={saleId} fn="cancelStuckDraw" label="Cancel sale" />
                          </>
                        )}
                      </>
                    )
                  )}
                </>
              )}
              {phase === "Drawn" && (
                <>
                  <p className="text-muted-foreground">The seed has arrived. Finalize runs the shuffle, credits the treasury and unlocks refunds.</p>
                  <SaleAction fair={fair} saleId={saleId} fn="finalize" label="Finalize" />
                </>
              )}
              {phase === "Cancelled" && (
                <>
                  <p className="text-muted-foreground">Cancelled: the draw was never delivered. Every subscriber gets a full refund.</p>
                  {me >= 0 && myRefunded === false && <SaleAction fair={fair} saleId={saleId} fn="claimRefund" label={`Claim ${formatUsdc(sale.pricePerSlot)} refund`} />}
                  {me >= 0 && myRefunded === true && <Alert>Your refund was paid.</Alert>}
                </>
              )}
              {phase === "Finalized" && (
                <>
                  <p className="text-muted-foreground">
                    Settled. Treasury {treasuryOwed > 0n ? "is owed" : "received"} {formatUsdc(sale.pricePerSlot * BigInt(Math.min(n, k)))}.
                  </p>
                  {treasuryOwed > 0n && <SaleAction fair={fair} saleId={saleId} fn="withdrawTreasury" label="Pay treasury" />}
                  {creatorOwed > 0n && <SaleAction fair={fair} saleId={saleId} fn="withdrawCreatorBounty" label={`Return ${formatUsdc(creatorOwed)} bounty to creator`} />}
                  {me >= 0 && myWin === true && <Alert variant="ok">You received an allocation.</Alert>}
                  {me >= 0 && myWin === false && myRefunded === false && <SaleAction fair={fair} saleId={saleId} fn="claimRefund" label={`Claim ${formatUsdc(sale.pricePerSlot)} refund`} />}
                  {me >= 0 && myRefunded === true && <Alert>Your refund was paid.</Alert>}
                </>
              )}
            </CardContent>
          </Card>

          {sale.requestId > 0n && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Randomness</CardTitle>
                <CardDescription>Audit the draw end to end.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-2 text-sm">
                <p>
                  ArcDraw request{" "}
                  <Link className="font-mono text-signal-ink underline underline-offset-4" href={`/r/?id=${sale.requestId}`}>
                    #{sale.requestId.toString()}
                  </Link>
                </p>
                {!/^0x0+$/.test(sale.seed) && (
                  <p className="break-hex font-mono text-xs text-muted-foreground">seed {sale.seed}</p>
                )}
              </CardContent>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-card p-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular mt-1 truncate font-mono">{children}</dd>
    </div>
  );
}

function SaleAction({ fair, saleId, fn, label }: { fair: Address; saleId: bigint; fn: "draw" | "finalize" | "claimRefund" | "withdrawTreasury" | "withdrawCreatorBounty" | "syncSeed" | "cancelStuckDraw"; label: string }) {
  const queryClient = useQueryClient();
  const { state, run, busy } = useTx();
  return (
    <WalletGate action={label.toLowerCase()}>
      <div className="grid gap-2">
        <Button
          variant="signal"
          disabled={busy}
          onClick={async () => {
            const r = await run({ label, address: fair, abi: fairAllocationFullAbi, functionName: fn, args: [saleId], gasBufferPct: fn === "finalize" ? 15 : undefined });
            if (r) await queryClient.invalidateQueries();
          }}
        >
          {label}
        </Button>
        <TxStatus state={state} />
      </div>
    </WalletGate>
  );
}

function Subscribe({ fair, saleId, price }: { fair: Address; saleId: bigint; price: bigint }) {
  const { address } = useConnection();
  const { data: walletClient } = useWalletClient({ chainId: arcMainnet.id });
  const queryClient = useQueryClient();
  const { state, run, busy } = useTx();
  const [signError, setSignError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);

  const usdc = useReadContracts({
    contracts: address
      ? [
          { address: USDC_ADDRESS, abi: usdcAbi, functionName: "balanceOf", args: [address], chainId: arcMainnet.id },
          { address: USDC_ADDRESS, abi: usdcAbi, functionName: "nonces", args: [address], chainId: arcMainnet.id },
          { address: USDC_ADDRESS, abi: usdcAbi, functionName: "name", chainId: arcMainnet.id },
        ]
      : [],
    query: { enabled: Boolean(address) },
  });
  const balance = usdc.data?.[0]?.result as bigint | undefined;
  const nonce = usdc.data?.[1]?.result as bigint | undefined;
  const name = usdc.data?.[2]?.result as string | undefined;

  async function subscribe() {
    setSignError(null);
    if (!walletClient || !address || nonce === undefined || !name) {
      setSignError("Wallet or USDC data not ready yet. Try again in a second.");
      return;
    }
    let sig: { v: number; r: `0x${string}`; s: `0x${string}` };
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);
    try {
      setSigning(true);
      const signature = await walletClient.signTypedData({
        account: address,
        domain: { name, version: "2", chainId: arcMainnet.id, verifyingContract: USDC_ADDRESS },
        types: {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "Permit",
        message: { owner: address, spender: fair, value: price, nonce, deadline },
      });
      const p = parseSignature(signature);
      sig = { v: Number(p.v ?? BigInt((p.yParity ?? 0) + 27)), r: p.r, s: p.s };
    } catch (e) {
      setSignError(explainError(e));
      return;
    } finally {
      setSigning(false);
    }
    const r = await run({
      label: "Subscribe",
      address: fair,
      abi: fairAllocationFullAbi,
      functionName: "subscribeWithPermit",
      args: [saleId, deadline, sig.v, sig.r, sig.s],
    });
    if (r) await queryClient.invalidateQueries();
  }

  const short = balance !== undefined && balance < price;
  return (
    <WalletGate action="subscribe">
      <div className="grid gap-2">
        <Button variant="signal" disabled={busy || signing || short} onClick={subscribe}>
          {signing ? "Sign the USDC permit…" : `Subscribe for ${formatUsdc(price)}`}
        </Button>
        <p className="text-xs text-muted-foreground">
          One signature (EIP-2612 permit for exactly {formatUsdc(price)}) and one transaction. No unlimited approval.
        </p>
        {short && <Alert variant="warn">Your balance ({formatUsdc(balance!)}) is below the slot price.</Alert>}
        {signError && <Alert variant="danger">{signError}</Alert>}
        <TxStatus state={state} />
      </div>
    </WalletGate>
  );
}

