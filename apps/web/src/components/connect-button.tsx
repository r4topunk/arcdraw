"use client";

import { Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import { Button } from "@/components/ui/button";
import { arcMainnet } from "@/lib/chain";
import { explainError } from "@/lib/errors";
import { shortHex } from "@/lib/format";

export function ConnectButton({ size = "sm" }: { size?: "sm" | "default" }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { address, chainId, status } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const [error, setError] = useState<string | null>(null);

  if (!mounted) {
    return (
      <Button size={size} variant="outline" disabled aria-label="Loading wallet">
        <Wallet aria-hidden /> Connect
      </Button>
    );
  }

  if (status === "connected" && address) {
    if (chainId !== arcMainnet.id) {
      return (
        <Button
          size={size}
          variant="signal"
          onClick={() => switchChain.mutate({ chainId: arcMainnet.id })}
          disabled={switchChain.isPending}
        >
          Switch to Arc
        </Button>
      );
    }
    return (
      <Button
        size={size}
        variant="outline"
        onClick={() => disconnect.mutate()}
        title="Disconnect"
        aria-label={`Connected as ${address}. Click to disconnect`}
        className="font-mono"
      >
        <span className="size-2 rounded-full bg-ok" aria-hidden />
        {shortHex(address, 4, 4)}
      </Button>
    );
  }

  const injectedConnector = connectors[0];
  return (
    <span className="inline-flex flex-col items-end">
      <Button
        size={size}
        variant="default"
        disabled={!injectedConnector || connect.isPending}
        onClick={() => {
          setError(null);
          if (!injectedConnector) return;
          connect.mutate(
            { connector: injectedConnector, chainId: arcMainnet.id },
            { onError: (e) => setError(explainError(e)) },
          );
        }}
      >
        <Wallet aria-hidden />
        {connect.isPending ? "Connecting…" : "Connect wallet"}
      </Button>
      {error && (
        <span role="alert" className="sr-only">
          {error}
        </span>
      )}
    </span>
  );
}
