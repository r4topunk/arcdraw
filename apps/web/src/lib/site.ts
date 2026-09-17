export const site = {
  name: "ArcDraw",
  tagline: "Verifiable randomness for Arc",
  description:
    "Permissionless randomness on Arc: pin a future drand quicknet round, verify the League of Entropy BLS signature onchain, pay the fulfiller in USDC.",
  // Owner sets this once the public repository exists.
  repoUrl: process.env.NEXT_PUBLIC_REPO_URL || "https://github.com/r4topunk/arcdraw",
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL || "https://arcdraw.xyz",
} as const;

export const repoFile = (path: string) => `${site.repoUrl}/blob/main/${path.replace(/^\/+/, "")}`;
