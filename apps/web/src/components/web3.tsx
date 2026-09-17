"use client";

import { Check, Copy, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Abi, Address, ContractFunctionArgs, ContractFunctionName, Hex, TransactionReceipt } from "viem";
import { useConnection, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { ConnectButton } from "@/components/connect-button";
import { Alert } from "@/components/ui/alert";
import { arcMainnet, explorerAddress, explorerTx } from "@/lib/chain";
import { explainError } from "@/lib/errors";
import { shortHex } from "@/lib/format";
import { repoFile } from "@/lib/site";
import { cn } from "@/lib/utils";

export function TxLink({ hash, label, className }: { hash: string; label?: string; className?: string }) {
  return (
    <a
      href={explorerTx(hash)}
      target="_blank"
      rel="noreferrer"
      className={cn("inline-flex items-center gap-1 font-mono text-signal-ink underline-offset-4 hover:underline", className)}
      aria-label={`${label ?? "Transaction"} ${hash} on Arc explorer`}
    >
      {label ? <span className="font-sans">{label}</span> : shortHex(hash, 6, 6)}
      <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}

export function AddressLink({ address, className }: { address: string; className?: string }) {
  return (
    <a
      href={explorerAddress(address)}
      target="_blank"
      rel="noreferrer"
      className={cn("inline-flex items-center gap-1 font-mono underline-offset-4 hover:underline", className)}
      aria-label={`Address ${address} on Arc explorer`}
    >
      {shortHex(address, 4, 4)}
      <ExternalLink className="size-3 opacity-60" aria-hidden />
    </a>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      aria-label={done ? "Copied" : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {done ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
    </button>
  );
}

export function NotDeployed({ what = "ArcDraw" }: { what?: string }) {
  return (
    <div className="rounded-lg border border-dashed bg-card p-6 sm:p-8">
      <p className="font-mono text-xs uppercase tracking-widest text-signal-ink">Not deployed yet</p>
      <h2 className="text-display mt-2 text-2xl font-semibold">{what} is not live on Arc mainnet yet</h2>
      <p className="mt-3 max-w-prose text-muted-foreground">
        The contracts are built and tested, but <code className="font-mono text-sm">deployments/arc-mainnet.json</code> has no
        addresses yet. Once the owner deploys, this page connects automatically. Meanwhile you can read the{" "}
        <Link className="text-signal-ink underline underline-offset-4" href="/docs/integration/">integration guide</Link> or the{" "}
        <a className="text-signal-ink underline underline-offset-4" href={repoFile("deployments/arc-mainnet.json")} target="_blank" rel="noreferrer">
          deployment file
        </a>.
      </p>
    </div>
  );
}

/** Renders children only when a wallet is connected to Arc; otherwise a prompt. */
export function WalletGate({ children, action = "continue" }: { children: ReactNode; action?: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { status, chainId } = useConnection();
  const switchChain = useSwitchChain();
  if (!mounted) return null;
  if (status !== "connected") {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed p-4 text-sm">
        <span className="text-muted-foreground">Connect a browser wallet to {action}.</span>
        <ConnectButton />
      </div>
    );
  }
  if (chainId !== arcMainnet.id) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed p-4 text-sm">
        <span className="text-muted-foreground">Your wallet is on another network. ArcDraw runs on Arc mainnet (chain 5042).</span>
        <button
          type="button"
          className="rounded-md bg-signal px-3 py-1.5 text-white dark:text-background"
          onClick={() => switchChain.mutate({ chainId: arcMainnet.id })}
        >
          Switch to Arc
        </button>
      </div>
    );
  }
  return <>{children}</>;
}

export type TxState =
  | { phase: "idle" }
  | { phase: "wallet"; label: string }
  | { phase: "pending"; label: string; hash: Hex }
  | { phase: "done"; label: string; hash: Hex; receipt: TransactionReceipt }
  | { phase: "error"; label: string; message: string; hash?: Hex };

type WriteArgs<abi extends Abi, fn extends ContractFunctionName<abi, "nonpayable" | "payable">> = {
  label: string;
  address: Address;
  abi: abi;
  functionName: fn;
  args: ContractFunctionArgs<abi, "nonpayable" | "payable", fn>;
  /** Add headroom on top of eth_estimateGas, in percent (e.g. 25 for fulfill with callbacks). */
  gasBufferPct?: number;
};

/** simulate -> wallet -> wait for receipt, with plain-language errors. */
export function useTx() {
  const publicClient = usePublicClient({ chainId: arcMainnet.id });
  const { data: walletClient } = useWalletClient({ chainId: arcMainnet.id });
  const { address } = useConnection();
  const [state, setState] = useState<TxState>({ phase: "idle" });

  const run = useCallback(
    async <const abi extends Abi, fn extends ContractFunctionName<abi, "nonpayable" | "payable">>(
      w: WriteArgs<abi, fn>,
    ): Promise<TransactionReceipt | null> => {
      if (!publicClient || !walletClient || !address) {
        setState({ phase: "error", label: w.label, message: "Connect a wallet on Arc mainnet first." });
        return null;
      }
      let hash: Hex | undefined;
      try {
        setState({ phase: "wallet", label: w.label });
        const { request } = await publicClient.simulateContract({
          account: address,
          address: w.address,
          abi: w.abi as Abi,
          functionName: w.functionName as string,
          args: w.args as readonly unknown[],
        });
        const txRequest = { ...request } as Parameters<typeof walletClient.writeContract>[0];
        if (w.gasBufferPct) {
          const estimate = await publicClient.estimateContractGas({
            account: address,
            address: w.address,
            abi: w.abi as Abi,
            functionName: w.functionName as string,
            args: w.args as readonly unknown[],
          });
          txRequest.gas = (estimate * BigInt(100 + w.gasBufferPct)) / 100n;
        }
        hash = await walletClient.writeContract(txRequest);
        setState({ phase: "pending", label: w.label, hash });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          setState({ phase: "error", label: w.label, hash, message: "The transaction was included but reverted." });
          return null;
        }
        setState({ phase: "done", label: w.label, hash, receipt });
        return receipt;
      } catch (e) {
        setState({ phase: "error", label: w.label, hash, message: explainError(e) });
        return null;
      }
    },
    [publicClient, walletClient, address],
  );

  return { state, run, reset: () => setState({ phase: "idle" }), busy: state.phase === "wallet" || state.phase === "pending" };
}

export function TxStatus({ state }: { state: TxState }) {
  if (state.phase === "idle") return null;
  if (state.phase === "wallet")
    return <Alert aria-live="polite">{state.label}: confirm in your wallet…</Alert>;
  if (state.phase === "pending")
    return (
      <Alert aria-live="polite">
        {state.label}: waiting for Arc to include it… <TxLink hash={state.hash} />
      </Alert>
    );
  if (state.phase === "done")
    return (
      <Alert variant="ok" aria-live="polite">
        {state.label}: confirmed in block {state.receipt.blockNumber.toString()}. <TxLink hash={state.hash} />
      </Alert>
    );
  return (
    <Alert variant="danger">
      <span className="font-medium">{state.label} failed.</span> {state.message}{" "}
      {state.hash && <TxLink hash={state.hash} />}
    </Alert>
  );
}
