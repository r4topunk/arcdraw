import { Fragment } from "react";
import { cn } from "@/lib/utils";

const KEYWORDS =
  /\b(contract|function|external|internal|override|returns|return|mapping|public|constructor|import|from|uint256|uint32|uint96|uint64|bytes32|address|bool|is|memory|emit|event|const|await|new|export|let|if|else|pragma|solidity|true|false)\b/;
const TOKEN = /(\/\/[^\n]*|"[^"\n]*"|\b\d[\d_]*\b|\b[A-Za-z_]\w*\b)/g;

function highlight(line: string) {
  const parts = line.split(TOKEN);
  return parts.map((p, i) => {
    if (!p) return null;
    if (p.startsWith("//")) return <span key={i} className="text-muted-foreground italic">{p}</span>;
    if (p.startsWith("\"")) return <span key={i} className="text-ok">{p}</span>;
    if (/^\d/.test(p)) return <span key={i} className="text-signal-ink">{p}</span>;
    if (KEYWORDS.test(p) && p.match(KEYWORDS)?.[0] === p) return <span key={i} className="text-muted-foreground">{p}</span>;
    if (/^[A-Z]/.test(p)) return <span key={i} className="font-semibold">{p}</span>;
    return <Fragment key={i}>{p}</Fragment>;
  });
}

export function CodeBlock({ code, title, className }: { code: string; title?: string; className?: string }) {
  const lines = code.replace(/\n$/, "").split("\n");
  return (
    <figure className={cn("overflow-hidden rounded-lg border bg-card", className)}>
      {title && (
        <figcaption className="flex items-center gap-2 border-b px-4 py-2 font-mono text-xs text-muted-foreground">
          <span className="size-2 rounded-full bg-signal" aria-hidden />
          {title}
        </figcaption>
      )}
      <pre className="overflow-x-auto p-4 font-mono text-[0.8rem] leading-6">
        <code>
          {lines.map((l, i) => (
            <span key={i} className="block">
              {highlight(l)}
              {l === "" ? " " : null}
            </span>
          ))}
        </code>
      </pre>
    </figure>
  );
}
