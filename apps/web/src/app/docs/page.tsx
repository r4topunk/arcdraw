import { ArrowRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { DOCS } from "@/lib/docs";

export const metadata: Metadata = {
  title: "Docs",
  description: "Integrate ArcDraw randomness on Arc: guide, spec, gas report and FAQ.",
};

export default function DocsIndex() {
  return (
    <div className="max-w-3xl">
      <p className="font-mono text-xs uppercase tracking-widest text-signal-ink">Documentation</p>
      <h1 className="text-display mt-3 text-4xl font-bold sm:text-5xl">Everything behind the draw.</h1>
      <p className="mt-4 text-lg text-muted-foreground">
        Start with the integration guide. The spec is the binding description of what the contracts do; the gas report is generated
        from Foundry runs with real drand signatures.
      </p>
      <ul className="mt-10 divide-y border-y">
        {DOCS.map((d, i) => (
          <li key={d.slug}>
            <Link href={`/docs/${d.slug}/`} className="group grid grid-cols-[2.5rem_1fr_auto] items-center gap-3 py-5">
              <span className="font-mono text-xs text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
              <span>
                <span className="block font-semibold group-hover:text-signal-ink">{d.title}</span>
                <span className="block text-sm text-muted-foreground">{d.summary}</span>
              </span>
              <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-1" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
