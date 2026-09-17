import type { Metadata } from "next";
import { Suspense } from "react";
import { AllocationApp } from "./allocation-app";

export const metadata: Metadata = {
  title: "Fair allocation demo",
  description:
    "An oversubscribed USDC sale settled with verifiable drand randomness on Arc: subscribe, draw, finalize, refund.",
};

export default function AllocationPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-6xl px-4 py-14 text-muted-foreground">Loading…</div>}>
      <AllocationApp />
    </Suspense>
  );
}
