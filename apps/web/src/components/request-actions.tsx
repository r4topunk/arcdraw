"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Address, Hex } from "viem";
import { usePublicClient } from "wagmi";
import { TxStatus, useTx, WalletGate } from "@/components/web3";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { arcMainnet } from "@/lib/chain";
import { arcDrawCoordinatorAbi, REQUEST_STATUS, type RequestStatus } from "@/lib/contracts";
import { fetchBeacon, verifyBeacon } from "@/lib/drand";
import { explainError } from "@/lib/errors";

export function StatusBadge({ status }: { status: RequestStatus }) {
  const variant = status === "Fulfilled" ? "ok" : status === "Pending" ? "signal" : status === "Refunded" ? "warn" : "default";
  return <Badge variant={variant}>{status}</Badge>;
}

export const statusOf = (n: number): RequestStatus => REQUEST_STATUS[n] ?? "None";

/** "Fulfill it yourself": fetch the drand beacon, verify it in the browser, submit it. */
export function FulfillButton({
  coordinator,
  requestId,
  round,
  size = "sm",
}: {
  coordinator: Address;
  requestId: bigint;
  round: bigint;
  size?: "sm" | "default";
}) {
  const publicClient = usePublicClient({ chainId: arcMainnet.id });
  const queryClient = useQueryClient();
  const { state, run, busy } = useTx();
  const [prep, setPrep] = useState<string | null>(null);
  const [prepError, setPrepError] = useState<string | null>(null);

  async function onClick() {
    setPrepError(null);
    try {
      setPrep("Fetching drand beacon…");
      const beacon = await fetchBeacon(round);
      setPrep("Verifying BLS signature in your browser…");
      await new Promise((r) => setTimeout(r, 0));
      if (!verifyBeacon(beacon)) throw new Error("The drand beacon did not verify locally, so it was not submitted.");
      let signature: Hex = beacon.signature;
      if (publicClient) {
        const stored = await publicClient.readContract({
          address: coordinator,
          abi: arcDrawCoordinatorAbi,
          functionName: "roundRandomness",
          args: [round],
        });
        if (BigInt(stored) !== 0n) signature = "0x"; // round already verified onchain: reuse it, cheaper calldata
      }
      setPrep(null);
      const receipt = await run({
        label: `Fulfill request #${requestId}`,
        address: coordinator,
        abi: arcDrawCoordinatorAbi,
        functionName: "fulfill",
        args: [requestId, signature],
        gasBufferPct: 25,
      });
      if (receipt) await queryClient.invalidateQueries();
    } catch (e) {
      setPrep(null);
      setPrepError(explainError(e));
    }
  }

  return (
    <WalletGate action="fulfill this request">
      <div className="grid gap-2">
        <Button size={size} variant="signal" onClick={onClick} disabled={busy || prep !== null}>
          {prep ?? "Fulfill it yourself"}
        </Button>
        {prepError && <Alert variant="danger">{prepError}</Alert>}
        <TxStatus state={state} />
      </div>
    </WalletGate>
  );
}

export function RefundButton({ coordinator, requestId }: { coordinator: Address; requestId: bigint }) {
  const queryClient = useQueryClient();
  const { state, run, busy } = useTx();
  return (
    <WalletGate action="refund this request">
      <div className="grid gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={async () => {
            const r = await run({
              label: `Refund request #${requestId}`,
              address: coordinator,
              abi: arcDrawCoordinatorAbi,
              functionName: "refund",
              args: [requestId],
            });
            if (r) await queryClient.invalidateQueries();
          }}
        >
          Refund bounty
        </Button>
        <TxStatus state={state} />
      </div>
    </WalletGate>
  );
}
