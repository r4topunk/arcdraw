"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleDashed, XCircle } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { getAbiItem, type Address, type Hex } from "viem";
import { usePublicClient, useReadContracts } from "wagmi";
import { FulfillButton, RefundButton, StatusBadge, statusOf } from "@/components/request-actions";
import { AddressLink, CopyButton, NotDeployed, TxLink } from "@/components/web3";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { arcMainnet } from "@/lib/chain";
import { arcDrawCoordinatorAbi, fairAllocationFullAbi } from "@/lib/contracts";
import { deployments } from "@/lib/deployments";
import { QUICKNET, deriveRandomness, fetchBeacon, roundTime, verifyBeacon } from "@/lib/drand";
import { explainError } from "@/lib/errors";
import { formatDuration, formatInt, formatTime, formatUsdc } from "@/lib/format";
import { findLogsNear } from "@/lib/logs";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

export function Inspector() {
  const params = useSearchParams();
  const raw = params.get("id") ?? "";
  const id = /^\d+$/.test(raw) && raw !== "0" ? BigInt(raw) : null;
  const coordinator = deployments.coordinator;

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
      <p className="font-mono text-xs uppercase tracking-widest text-signal-ink">Inspector</p>
      <h1 className="text-display mt-2 text-4xl font-bold sm:text-5xl">{id ? `Request #${id}` : "Inspect a request"}</h1>
      <p className="mt-3 max-w-2xl text-muted-foreground">
        Everything needed to audit a draw: the pinned drand round, its BLS signature checked in your browser, and the per-request
        value recomputed from public inputs.
      </p>
      <IdForm initial={raw} />
      <div className="mt-10">
        {!coordinator ? <NotDeployed what="The ArcDraw coordinator" /> : id ? <RequestView coordinator={coordinator} id={id} /> : null}
      </div>
    </div>
  );
}

function IdForm({ initial }: { initial: string }) {
  const router = useRouter();
  const [v, setV] = useState(initial);
  return (
    <form
      className="mt-6 flex max-w-sm items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (/^\d+$/.test(v.trim())) router.push(`/r/?id=${v.trim()}`);
      }}
    >
      <div className="grid flex-1 gap-1.5">
        <Label htmlFor="rid">Request id</Label>
        <Input id="rid" inputMode="numeric" value={v} onChange={(e) => setV(e.target.value)} placeholder="e.g. 1" />
      </div>
      <Button type="submit" variant="outline">Inspect</Button>
    </form>
  );
}

function RequestView({ coordinator, id }: { coordinator: Address; id: bigint }) {
  const now = useNow(1000);
  const client = usePublicClient({ chainId: arcMainnet.id });
  const base = { address: coordinator, abi: arcDrawCoordinatorAbi, chainId: arcMainnet.id } as const;
  const reads = useReadContracts({
    contracts: [
      { ...base, functionName: "getRequest", args: [id] },
      { ...base, functionName: "expiresAt", args: [id] },
    ],
    query: { refetchInterval: 3000 },
  });
  const req = reads.data?.[0]?.result;
  const expiresAt = reads.data?.[1]?.result;
  const status = req ? statusOf(req.status) : null;

  const roundTs = req ? Number(roundTime(req.round)) : null;
  const published = now !== null && roundTs !== null && now >= roundTs;

  const onchainRound = useReadContracts({
    contracts: req ? [{ ...base, functionName: "roundRandomness", args: [req.round] }] : [],
    query: { enabled: Boolean(req), refetchInterval: 3000 },
  });
  const storedDrand = onchainRound.data?.[0]?.result as Hex | undefined;

  const beacon = useQuery({
    queryKey: ["beacon", req?.round.toString()],
    enabled: Boolean(req) && published,
    queryFn: async () => {
      const b = await fetchBeacon(req!.round);
      const t0 = performance.now();
      const ok = verifyBeacon(b);
      return { beacon: b, ok, ms: performance.now() - t0 };
    },
    staleTime: Infinity,
    retry: 3,
    retryDelay: 1500,
  });

  const sale = useReadContracts({
    contracts:
      req && deployments.fairAllocation && req.requester === deployments.fairAllocation
        ? [{ address: deployments.fairAllocation, abi: fairAllocationFullAbi, functionName: "saleOfRequest", args: [id], chainId: arcMainnet.id }]
        : [],
    query: { enabled: Boolean(req && deployments.fairAllocation && req.requester === deployments.fairAllocation) },
  });
  const saleId = sale.data?.[0]?.result as bigint | undefined;

  const txs = useQuery({
    queryKey: ["request-txs", coordinator, id.toString(), status],
    enabled: Boolean(client && req && status !== "None"),
    queryFn: async () => {
      const requested = await findLogsNear(client!, {
        address: coordinator,
        event: getAbiItem({ abi: arcDrawCoordinatorAbi, name: "RandomnessRequested" }),
        args: { requestId: id },
        aroundTs: req!.createdAt,
      });
      const fulfilled =
        status === "Fulfilled"
          ? await findLogsNear(client!, {
              address: coordinator,
              event: getAbiItem({ abi: arcDrawCoordinatorAbi, name: "RandomnessFulfilled" }),
              args: { requestId: id },
              aroundTs: BigInt(roundTs!),
              minBlock: requested[0]?.blockNumber ?? undefined,
              maxChunks: 20,
            })
          : [];
      const refunded =
        status === "Refunded" || (status === "Fulfilled" && req!.bounty === 0n)
          ? await findLogsNear(client!, {
              address: coordinator,
              event: getAbiItem({ abi: arcDrawCoordinatorAbi, name: "BountyRefunded" }),
              args: { requestId: id },
              aroundTs: expiresAt ?? BigInt(roundTs! + 3600),
              minBlock: requested[0]?.blockNumber ?? undefined,
              maxChunks: 6,
            })
          : [];
      return {
        requested: requested[0]?.transactionHash ?? null,
        fulfilled: fulfilled[0]?.transactionHash ?? null,
        refunded: refunded[0]?.transactionHash ?? null,
      };
    },
    staleTime: 30_000,
  });

  if (reads.error) return <Alert variant="danger">Could not read request #{id.toString()}: {explainError(reads.error)}</Alert>;
  if (!req) return <div className="h-64 animate-pulse rounded-lg border bg-card" aria-label="Loading request" />;
  if (status === "None") return <Alert variant="warn">Request #{id.toString()} does not exist yet.</Alert>;

  const zero = /^0x0+$/;
  const drandRandomness = storedDrand && !zero.test(storedDrand) ? storedDrand : beacon.data?.ok ? beacon.data.beacon.randomness : undefined;
  const derived = drandRandomness
    ? deriveRandomness({ drandRandomness, chainId: arcMainnet.id, coordinator, requestId: id })
    : undefined;
  const fulfilledRandomness = status === "Fulfilled" ? req.randomness : undefined;

  return (
    <div className="grid gap-8">
      <section className="rounded-lg border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-5">
          <div className="flex items-center gap-3">
            <StatusBadge status={status!} />
            {status === "Pending" && !published && roundTs !== null && now !== null && (
              <span className="text-sm text-muted-foreground" aria-live="polite">
                Round publishes in {formatDuration(roundTs - now)}
              </span>
            )}
            {status === "Pending" && published && (
              <span className="text-sm text-muted-foreground" aria-live="polite">Round is out, waiting for a fulfiller</span>
            )}
          </div>
          {saleId !== undefined && (
            <Link href={`/allocation/?sale=${saleId}`} className="text-sm text-signal-ink underline underline-offset-4">
              FairAllocation sale #{saleId.toString()}
            </Link>
          )}
        </div>
        <dl className="grid gap-px bg-border sm:grid-cols-2">
          <Field label="Requester"><AddressLink address={req.requester} /></Field>
          <Field label="Created">{formatTime(req.createdAt)}</Field>
          <Field label="drand round">
            <a
              className="font-mono underline-offset-4 hover:underline"
              href={`https://api.drand.sh/${QUICKNET.chainHash}/public/${req.round}`}
              target="_blank"
              rel="noreferrer"
            >
              #{formatInt(req.round)}
            </a>
          </Field>
          <Field label="Round timestamp">{roundTs !== null ? formatTime(roundTs) : "…"}</Field>
          <Field label={status === "Fulfilled" ? "Bounty" : "Bounty escrowed"}>
            <span className="tabular font-mono">{formatUsdc(req.bounty)}</span>
          </Field>
          <Field label="Callback gas limit">
            <span className="tabular font-mono">{formatInt(req.callbackGasLimit)}</span>
          </Field>
          <Field label="Refundable from">{expiresAt !== undefined ? formatTime(expiresAt) : "…"}</Field>
          <Field label="Transactions">
            <span className="flex flex-wrap gap-x-4 gap-y-1">
              {txs.data?.requested && <TxLink hash={txs.data.requested} label="Request" />}
              {txs.data?.refunded && <TxLink hash={txs.data.refunded} label="Refund" />}
              {txs.data?.fulfilled && <TxLink hash={txs.data.fulfilled} label="Fulfill" />}
              {txs.isLoading && <span className="text-muted-foreground">Searching logs…</span>}
              {txs.data && !txs.data.requested && !txs.isLoading && (
                <span className="text-muted-foreground">Not found near the request time</span>
              )}
              {txs.error && <span className="text-danger">{explainError(txs.error)}</span>}
            </span>
          </Field>
        </dl>
        {(status === "Pending" || status === "Refunded") && published && (
          <div className="flex flex-wrap items-start gap-3 border-t p-5">
            <FulfillButton coordinator={coordinator} requestId={id} round={req.round} size="default" />
            {status === "Pending" && req.bounty > 0n && expiresAt !== undefined && now !== null && now >= Number(expiresAt) && (
              <RefundButton coordinator={coordinator} requestId={id} />
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="verify-title">
        <h2 id="verify-title" className="text-display text-2xl font-semibold">Verification</h2>
        <p className="mt-1 text-sm text-muted-foreground">Each check runs in this browser from public data.</p>
        <ol className="mt-5 grid gap-3">
          <Check
            n={1}
            state={!published ? "wait" : beacon.isLoading ? "wait" : beacon.data?.ok ? "ok" : beacon.error || beacon.data ? "fail" : "wait"}
            title="drand BLS signature is valid for this round"
            detail={
              !published
                ? "The round is not published yet."
                : beacon.error
                  ? `Could not fetch the beacon: ${explainError(beacon.error)}`
                  : beacon.data
                    ? beacon.data.ok
                      ? `Verified against the quicknet public key with @noble/curves in ${beacon.data.ms.toFixed(0)} ms.`
                      : "The signature returned by the drand API did not verify."
                    : "Fetching the beacon…"
            }
          >
            {beacon.data && <HexRow label="Signature (G1, 48 bytes)" value={beacon.data.beacon.signature} />}
          </Check>
          <Check
            n={2}
            state={!storedDrand || zero.test(storedDrand) ? "wait" : beacon.data ? (beacon.data.beacon.randomness === storedDrand ? "ok" : "fail") : "wait"}
            title="Onchain round value equals sha256(signature)"
            detail={
              !storedDrand || zero.test(storedDrand)
                ? "Round not verified onchain yet. The first fulfill stores it."
                : "The coordinator stored this value after its own pairing check through the EIP-2537 precompiles."
            }
          >
            {storedDrand && !zero.test(storedDrand) && <HexRow label="roundRandomness(round)" value={storedDrand} />}
          </Check>
          <Check
            n={3}
            state={fulfilledRandomness && derived ? (fulfilledRandomness === derived ? "ok" : "fail") : "wait"}
            title="Delivered value = keccak256(drand, chainId, coordinator, requestId)"
            detail={
              fulfilledRandomness
                ? fulfilledRandomness === derived
                  ? "Recomputed here and matches the value stored onchain and sent to the consumer."
                  : derived
                    ? "Mismatch between the recomputed and stored value."
                    : "Waiting for the drand value to recompute."
                : derived
                  ? "Not fulfilled yet. This value is already determined and is what will be delivered."
                  : "Available once the round is out."
            }
          >
            {(fulfilledRandomness || derived) && (
              <HexRow label={fulfilledRandomness ? "Randomness (onchain)" : "Randomness (precomputed)"} value={(fulfilledRandomness ?? derived)!} strong />
            )}
          </Check>
        </ol>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bg-card px-5 py-3.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}

function Check({
  n,
  state,
  title,
  detail,
  children,
}: {
  n: number;
  state: "ok" | "fail" | "wait";
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  const Icon = state === "ok" ? CheckCircle2 : state === "fail" ? XCircle : CircleDashed;
  const label = state === "ok" ? "passed" : state === "fail" ? "failed" : "pending";
  return (
    <li className={cn("rounded-lg border bg-card p-4 sm:p-5", state === "fail" && "border-danger/50")}>
      <div className="flex gap-3">
        <Icon
          className={cn("mt-0.5 size-5 shrink-0", state === "ok" ? "text-ok" : state === "fail" ? "text-danger" : "text-muted-foreground")}
          aria-label={`Check ${n} ${label}`}
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{title}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{detail}</p>
          {children && <div className="mt-3 grid gap-2">{children}</div>}
        </div>
      </div>
    </li>
  );
}

function HexRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <CopyButton value={value} label={`Copy ${label}`} />
      </div>
      <p className={cn("break-hex mt-1 font-mono text-xs leading-relaxed", strong && "text-signal-ink")}>{value}</p>
    </div>
  );
}
