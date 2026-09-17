import type { NextConfig } from "next";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
  // Keep next dev from writing AGENTS.md/CLAUDE.md here; the repo-level AGENTS.md is the source of truth.
  agentRules: false,
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
};

export default nextConfig;
