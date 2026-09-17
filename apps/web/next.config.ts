import type { NextConfig } from "next";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");

// The fallbacks in src/lib/site.ts are placeholders. Warn on every build without the real values, and fail when
// REQUIRE_SITE_ENV=true (set it in the production build so broken repo links or a wrong canonical URL never ship).
const missingSiteEnv = ["NEXT_PUBLIC_REPO_URL", "NEXT_PUBLIC_SITE_URL"].filter((k) => !process.env[k]);
if (missingSiteEnv.length > 0) {
  const msg = `[arcdraw] ${missingSiteEnv.join(", ")} not set: using placeholder URLs from src/lib/site.ts`;
  if (process.env.REQUIRE_SITE_ENV === "true") throw new Error(msg);
  console.warn(msg);
}

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
