import type { ReactNode } from "react";
import { DocsNav } from "@/components/docs-nav";
import { DOCS } from "@/lib/docs";

export default function DocsLayout({ children }: { children: ReactNode }) {
  const items = DOCS.map(({ slug, title }) => ({ slug, title }));
  return (
    <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 md:grid-cols-[13rem_1fr] md:gap-12 md:py-14">
      <aside className="md:sticky md:top-20 md:self-start">
        <DocsNav items={items} />
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
