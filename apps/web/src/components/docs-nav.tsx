"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function DocsNav({ items }: { items: { slug: string; title: string }[] }) {
  const pathname = usePathname();
  const links = [{ slug: "", title: "Overview" }, ...items];
  return (
    <nav aria-label="Documentation">
      <p className="mb-3 hidden font-mono text-xs uppercase tracking-widest text-muted-foreground md:block">Docs</p>
      <ul className="-mx-1 flex gap-1 overflow-x-auto pb-1 md:mx-0 md:flex-col md:overflow-visible">
        {links.map((l) => {
          const href = l.slug ? `/docs/${l.slug}/` : "/docs/";
          const active = pathname === href || pathname === href.replace(/\/$/, "");
          return (
            <li key={href} className="shrink-0">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "block rounded-md px-3 py-1.5 text-sm whitespace-nowrap",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {l.title}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
