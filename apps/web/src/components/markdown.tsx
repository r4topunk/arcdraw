import path from "node:path";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { DOCS } from "@/lib/docs";
import { repoFile } from "@/lib/site";

/** Rewrite repo-relative links: known docs go to their page, everything else to the repository. */
function resolveHref(href: string, docFile: string): { href: string; internal: boolean; external: boolean } {
  if (/^(https?:|mailto:)/.test(href)) return { href, internal: false, external: true };
  if (href.startsWith("#") || href.startsWith("/")) return { href, internal: true, external: false };
  const [p, hash] = href.split("#");
  const repoPath = path.posix.normalize(path.posix.join(path.posix.dirname(docFile), p));
  const doc = DOCS.find((d) => d.file === repoPath);
  if (doc) return { href: `/docs/${doc.slug}/${hash ? `#${hash}` : ""}`, internal: true, external: false };
  return { href: repoFile(repoPath), internal: false, external: true };
}

export function Markdown({ source, docFile }: { source: string; docFile: string }) {
  return (
    <div className="prose-doc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSlug]}
        components={{
          a({ href = "", children }) {
            const r = resolveHref(href, docFile);
            if (r.internal) return <Link href={r.href}>{children}</Link>;
            return (
              <a href={r.href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
          table({ children }) {
            return <table>{children}</table>;
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
