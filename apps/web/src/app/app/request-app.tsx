"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { parseEventLogs, type Address } from "viem";
import { useConnection, useReadContract, useReadContracts } from "wagmi";
import { FulfillButton, RefundButton, StatusBadge, statusOf } from "@/components/request-actions";
import { AddressLink, NotDeployed, TxLink, TxStatus, useTx, WalletGate } from "@/components/web3";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { arcMainnet, USDC_ADDRESS } from "@/lib/chain";
import { arcDrawCoordinatorAbi, MAX_CALLBACK_GAS_LIMIT, REQUEST_TIMEOUT_S, usdcAbi } from "@/lib/contracts";
import { deployments } from "@/lib/deployments";
import { roundAt, roundTime } from "@/lib/drand";
import { explainError } from "@/lib/errors";
import { formatDuration, formatInt, formatUsdc, parseUsdc } from "@/lib/format";
import { useNow } from "@/lib/use-now";

const PAGE = 12n;

export function RequestApp() {
  const coordinator = deployments.coordinator;
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:py-14">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-signal-ink">Live app · Arc mainnet</p>
          <h1 className="text-display mt-2 text-4xl font-bold sm:text-5xl">Request randomness</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Pin a future drand round from your wallet, then watch a relayer deliver it, or deliver it yourself. Every action links to
            the Arc explorer.
          </p>
        </div>
        <InspectById />
      </header>
      <div className="mt-10">{coordinator ? <Live coordinator={coordinator} /> : <NotDeployed what="The ArcDraw coordinator" />}</div>
    </div>
  );
}

function InspectById() {
  const router = useRouter();
  const [id, setId] = useState("");
  return (
    <form
      className="flex w-full items-end gap-2 sm:w-auto"
      onSubmit={(e) => {
        e.preventDefault();
        if (/^\d+$/.test(id.trim())) router.push(`/r/?id=${id.trim()}`);
      }}
    >
      <div className="grid flex-1 gap-1.5">
        <Label htmlFor="inspect-id">Inspect a request</Label>
        <Input id="inspect-id" inputMode="numeric" placeholder="Request id" value={id} onChange={(e) => setId(e.target.value)} className="sm:w-40" />
      </div>
      <Button type="submit" variant="outline" size="icon" aria-label="Inspect request">
        <Search aria-hidden />
      </Button>
    </form>
  );
}

function Live({ coordinator }: { coordinator: Address }) {
  const now = useNow(1000);
  const count = useReadContract({
    address: coordinator,
    abi: arcDrawCoordinatorAbi,
    functionName: "requestCount",
    chainId: arcMainnet.id,
    query: { refetchInterval: 4000 },
  });
  const current = now ? roundAt(BigInt(Math.floor(now))) : null;

  return (
    <div className="grid gap-8">
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
        <Stat label="Coordinator" value={<AddressLink address={coordinator} />} />
        <Stat label="Requests created" value={count.data !== undefined ? formatInt(count.data) : "…"} />
        <Stat label="drand round now" value={current ? `#${formatInt(current)}` : "…"} />
        <Stat label="Next request pins" value={current ? `#${formatInt(current + 2n)}` : "…"} />
      </dl>
      {count.error && <Alert variant="danger">Could not read the coordinator: {explainError(count.error)}</Alert>}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,24rem)_1fr]">
        <RequestForm coordinator={coordinator} />
        <RecentRequests coordinator={coordinator} count={count.data} now={now} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-card p-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular mt-1 truncate font-mono text-base sm:text-lg">{value}</dd>
    </div>
  );
}

function RequestForm({ coordinator }: { coordinator: Address }) {
  const { address } = useConnection();
  const queryClient = useQueryClient();
  const [gas, setGas] = useState("0");
  const [bountyInput, setBountyInput] = useState("0");
  const [created, setCreated] = useState<{ id: bigint; round: bigint; hash: string } | null>(null);
  const approveTx = useTx();
  const requestTx = useTx();

  const bounty = parseUsdc(bountyInput);
  const gasNum = /^\d+$/.test(gas.trim()) ? Number(gas.trim()) : NaN;
  const gasError = Number.isNaN(gasNum) ? "Whole number of gas units." : gasNum > MAX_CALLBACK_GAS_LIMIT ? `Maximum is ${formatInt(MAX_CALLBACK_GAS_LIMIT)}.` : null;
  const bountyError = bounty === null ? "Up to 6 decimals, for example 0.01." : bounty >= 2n ** 96n ? "Too large." : null;

  const balances = useReadContracts({
    contracts: address
      ? [
          { address: USDC_ADDRESS, abi: usdcAbi, functionName: "balanceOf", args: [address], chainId: arcMainnet.id },
          { address: USDC_ADDRESS, abi: usdcAbi, functionName: "allowance", args: [address, coordinator], chainId: arcMainnet.id },
        ]
      : [],
    query: { enabled: Boolean(address), refetchInterval: 8000 },
  });
  const balance = balances.data?.[0]?.result as bigint | undefined;
  const allowance = balances.data?.[1]?.result as bigint | undefined;
  const needsApproval = bounty !== null && bounty > 0n && (allowance ?? 0n) < bounty;

  async function submit() {
    if (gasError || bountyError || bounty === null) return;
    setCreated(null);
    if (needsApproval) {
      const ok = await approveTx.run({
        label: `Approve ${formatUsdc(bounty)}`,
        address: USDC_ADDRESS,
        abi: usdcAbi,
        functionName: "approve",
        args: [coordinator, bounty],
      });
      if (!ok) return;
      await balances.refetch();
    }
    const receipt = await requestTx.run({
      label: "Request randomness",
      address: coordinator,
      abi: arcDrawCoordinatorAbi,
      functionName: "requestRandomness",
      args: [gasNum, bounty],
    });
    if (!receipt) return;
    const [evt] = parseEventLogs({ abi: arcDrawCoordinatorAbi, logs: receipt.logs, eventName: "RandomnessRequested" });
    if (evt) setCreated({ id: evt.args.requestId, round: evt.args.round, hash: receipt.transactionHash });
    await queryClient.invalidateQueries();
  }

  return (
    <Card className="self-start">
      <CardHeader>
        <CardTitle>New request</CardTitle>
        <CardDescription>
          Pins round current + 2. Gas is paid in USDC: about 0.002 USDC to request.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="bounty">Bounty for the fulfiller (USDC)</Label>
            <Input
              id="bounty"
              inputMode="decimal"
              value={bountyInput}
              onChange={(e) => setBountyInput(e.target.value)}
              aria-invalid={Boolean(bountyError)}
              aria-describedby="bounty-help"
            />
            <p id="bounty-help" className={bountyError ? "text-xs text-danger" : "text-xs text-muted-foreground"}>
              {bountyError ??
                "Optional. Paid to whoever submits the drand signature. Refundable 1 hour after the round if nobody does."}
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cb-gas">Callback gas limit</Label>
            <Input
              id="cb-gas"
              inputMode="numeric"
              value={gas}
              onChange={(e) => setGas(e.target.value)}
              aria-invalid={Boolean(gasError)}
              aria-describedby="gas-help"
            />
            <p id="gas-help" className={gasError ? "text-xs text-danger" : "text-xs text-muted-foreground"}>
              {gasError ?? "Leave 0 from a wallet. Callbacks only run when the requester is a contract."}
            </p>
          </div>

          {address && (
            <p className="text-xs text-muted-foreground">
              Balance: <span className="tabular font-mono text-foreground">{balance !== undefined ? formatUsdc(balance) : "…"}</span>
              {bounty !== null && bounty > 0n && (
                <>
                  {" "}· Allowance: <span className="tabular font-mono text-foreground">{allowance !== undefined ? formatUsdc(allowance) : "…"}</span>
                </>
              )}
            </p>
          )}

          <WalletGate action="request randomness">
            <Button type="submit" variant="signal" disabled={Boolean(gasError || bountyError) || approveTx.busy || requestTx.busy}>
              {needsApproval ? "Approve USDC, then request" : "Request randomness"}
            </Button>
          </WalletGate>
          <TxStatus state={approveTx.state} />
          <TxStatus state={requestTx.state} />
          {created && (
            <div className="rounded-md border border-ok/40 bg-ok-soft p-4 text-sm">
              <p className="font-medium text-ok">Request #{created.id.toString()} created for round #{formatInt(created.round)}.</p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <Link className="inline-flex items-center gap-1 font-medium underline underline-offset-4" href={`/r/?id=${created.id}`}>
                  Watch it resolve <ArrowRight className="size-3.5" aria-hidden />
                </Link>
                <TxLink hash={created.hash} />
              </div>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function RecentRequests({ coordinator, count, now }: { coordinator: Address; count: bigint | undefined; now: number | null }) {
  const [pages, setPages] = useState(1n);
  const ids = useMemo(() => {
    if (!count) return [] as bigint[];
    const out: bigint[] = [];
    const min = count > PAGE * pages ? count - PAGE * pages + 1n : 1n;
    for (let i = count; i >= min; i--) out.push(i);
    return out;
  }, [count, pages]);

  const reqs = useReadContracts({
    contracts: ids.map((id) => ({
      address: coordinator,
      abi: arcDrawCoordinatorAbi,
      functionName: "getRequest" as const,
      args: [id] as const,
      chainId: arcMainnet.id,
    })),
    query: { enabled: ids.length > 0, refetchInterval: 4000 },
  });

  return (
    <section aria-labelledby="recent-title" className="min-w-0">
      <div className="flex items-center justify-between">
        <h2 id="recent-title" className="text-lg font-semibold">
          Recent requests
        </h2>
        <span className="text-xs text-muted-foreground">Refreshes every 4s</span>
      </div>
      {count === 0n && (
        <p className="mt-4 rounded-md border border-dashed p-6 text-sm text-muted-foreground">No requests yet. Be the first.</p>
      )}
      {reqs.error && <Alert variant="danger" className="mt-4">{explainError(reqs.error)}</Alert>}
      <ul className="mt-4 grid gap-3">
        {ids.map((id, i) => {
          const r = reqs.data?.[i]?.result;
          if (!r) {
            return <li key={id.toString()} className="h-24 animate-pulse rounded-lg border bg-card" aria-hidden />;
          }
          const status = statusOf(r.status);
          const ts = Number(roundTime(r.round));
          const published = now !== null && now >= ts;
          const expiresAt = ts + REQUEST_TIMEOUT_S;
          const expired = now !== null && now >= expiresAt;
          return (
            <li key={id.toString()} className="rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <Link href={`/r/?id=${id}`} className="text-display text-xl font-semibold hover:text-signal-ink">
                    #{id.toString()}
                  </Link>
                  <StatusBadge status={status} />
                </div>
                <Link href={`/r/?id=${id}`} className="text-sm text-signal-ink underline-offset-4 hover:underline">
                  Inspect
                </Link>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-xs text-muted-foreground">Round</dt>
                  <dd className="tabular font-mono">#{formatInt(r.round)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Bounty</dt>
                  <dd className="tabular font-mono">{formatUsdc(r.bounty)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Requester</dt>
                  <dd><AddressLink address={r.requester} /></dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{status === "Fulfilled" ? "Randomness" : "Round out"}</dt>
                  <dd className="tabular truncate font-mono">
                    {status === "Fulfilled"
                      ? `${r.randomness.slice(0, 10)}…`
                      : now === null
                        ? "…"
                        : published
                          ? `${formatDuration(now - ts)} ago`
                          : `in ${formatDuration(ts - now)}`}
                  </dd>
                </div>
              </dl>
              {(status === "Pending" || status === "Refunded") && published && (
                <div className="mt-4 flex flex-wrap items-start gap-3 border-t pt-4">
                  <FulfillButton coordinator={coordinator} requestId={id} round={r.round} />
                  {status === "Pending" && expired && r.bounty > 0n && <RefundButton coordinator={coordinator} requestId={id} />}
                  {status === "Pending" && !expired && now !== null && r.bounty > 0n && (
                    <p className="self-center text-xs text-muted-foreground">Refundable in {formatDuration(expiresAt - now)}</p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {count !== undefined && count > PAGE * pages && (
        <Button variant="outline" className="mt-4 w-full" onClick={() => setPages((p) => p + 1n)}>
          Load older requests
        </Button>
      )}
    </section>
  );
}
