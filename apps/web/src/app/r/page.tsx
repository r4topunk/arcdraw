import type { Metadata } from "next";
import { Suspense } from "react";
import { Inspector } from "./inspector";

export const metadata: Metadata = {
  title: "Inspect request",
  description: "Audit an ArcDraw request: drand round, BLS signature verified in the browser, derived randomness and transactions.",
};

export default function InspectPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-4xl px-4 py-14 text-muted-foreground">Loading…</div>}>
      <Inspector />
    </Suspense>
  );
}
