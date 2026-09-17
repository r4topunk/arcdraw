import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.cwd(), "../..");
const webRoot = process.cwd();

export type DocEntry = {
  slug: string;
  title: string;
  summary: string;
  file: string; // relative to repo root
};

export const DOCS: DocEntry[] = [
  { slug: "integration", title: "Integration guide", summary: "Write a consumer, request randomness, run a relayer.", file: "apps/web/content/integration.md" },
  { slug: "spec", title: "Technical spec", summary: "Round math, coordinator semantics, trust model, test plan.", file: "docs/SPEC.md" },
  { slug: "gas", title: "Gas report", summary: "Measured gas and USDC cost for every call.", file: "docs/GAS.md" },
  { slug: "faq", title: "FAQ", summary: "Trust, latency, costs and limits in short answers.", file: "apps/web/content/faq.md" },
  { slug: "prd", title: "Product requirements", summary: "Problem, scope, non-goals, risks and roadmap.", file: "docs/PRD.md" },
];

export function readDoc(file: string): string {
  const abs = file.startsWith("apps/web/") ? path.join(webRoot, file.slice("apps/web/".length)) : path.join(repoRoot, file);
  return readFileSync(abs, "utf8");
}

export type GasRow = { scenario: string; gas: number; usdc: string; description: string };

/** Parse the main table of docs/GAS.md at build time so the landing page never drifts from the report. */
export function readGasTable(): GasRow[] {
  const md = readDoc("docs/GAS.md");
  const rows: GasRow[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*([\d,]+)\s*\|\s*([\d.]+)\s*\|\s*(.+?)\s*\|\s*$/);
    if (m) rows.push({ scenario: m[1], gas: Number(m[2].replace(/,/g, "")), usdc: m[3], description: m[4] });
  }
  return rows;
}
