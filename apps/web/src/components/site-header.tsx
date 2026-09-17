import Link from "next/link";
import { ConnectButton } from "@/components/connect-button";
import { LogoMark } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";

const nav = [
  { href: "/docs/", label: "Docs" },
  { href: "/app/", label: "App" },
  { href: "/allocation/", label: "Demo" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded focus:bg-card focus:px-3 focus:py-2">
        Skip to content
      </a>
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4 sm:gap-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight" aria-label="ArcDraw home">
          <LogoMark />
          <span className="text-display text-lg">ArcDraw</span>
        </Link>
        <nav aria-label="Main" className="flex items-center gap-0.5 text-sm sm:gap-1">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground sm:px-3">
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
          <div className="hidden sm:block">
            <ConnectButton />
          </div>
        </div>
      </div>
    </header>
  );
}
