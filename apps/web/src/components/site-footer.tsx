import Link from "next/link";
import { LogoMark } from "@/components/logo";
import { site } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 text-sm sm:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <LogoMark />
            <span className="text-display text-lg font-semibold">ArcDraw</span>
          </div>
          <p className="max-w-xs text-muted-foreground">
            Open-source, permissionless randomness for Arc. MIT licensed. Experimental and unaudited: use at your own risk.
          </p>
        </div>
        <div>
          <h2 className="mb-3 font-medium">Product</h2>
          <ul className="space-y-2 text-muted-foreground">
            <li><Link className="hover:text-foreground" href="/app/">Request randomness</Link></li>
            <li><Link className="hover:text-foreground" href="/allocation/">Fair allocation demo</Link></li>
            <li><Link className="hover:text-foreground" href="/r/">Inspect a request</Link></li>
          </ul>
        </div>
        <div>
          <h2 className="mb-3 font-medium">Docs</h2>
          <ul className="space-y-2 text-muted-foreground">
            <li><Link className="hover:text-foreground" href="/docs/integration/">Integration guide</Link></li>
            <li><Link className="hover:text-foreground" href="/docs/spec/">Technical spec</Link></li>
            <li><Link className="hover:text-foreground" href="/docs/gas/">Gas report</Link></li>
            <li><Link className="hover:text-foreground" href="/docs/faq/">FAQ</Link></li>
          </ul>
        </div>
        <div>
          <h2 className="mb-3 font-medium">Built on</h2>
          <ul className="space-y-2 text-muted-foreground">
            <li><a className="hover:text-foreground" href="https://drand.love" rel="noreferrer" target="_blank">drand / League of Entropy</a></li>
            <li><a className="hover:text-foreground" href="https://github.com/randa-mu/bls-solidity" rel="noreferrer" target="_blank">randa-mu/bls-solidity</a></li>
            <li><a className="hover:text-foreground" href="https://docs.arc.io" rel="noreferrer" target="_blank">Arc by Circle</a></li>
            <li><a className="hover:text-foreground" href={site.repoUrl} rel="noreferrer" target="_blank">Source code</a></li>
          </ul>
        </div>
      </div>
      <div className="border-t">
        <p className="mx-auto max-w-6xl px-4 py-5 text-xs text-muted-foreground">
          No analytics, no trackers, no cookies. The app reads Arc mainnet over public RPC and drand over its public HTTP API.
        </p>
      </div>
    </footer>
  );
}
