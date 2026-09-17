import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { ReactNode } from "react";
import { Providers } from "@/components/providers";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { site } from "@/lib/site";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(site.siteUrl),
  title: { default: "ArcDraw: verifiable randomness for Arc", template: "%s · ArcDraw" },
  description: site.description,
  applicationName: "ArcDraw",
  keywords: ["Arc", "randomness", "VRF", "drand", "BLS12-381", "EIP-2537", "USDC", "Circle"],
  openGraph: {
    type: "website",
    siteName: "ArcDraw",
    title: "ArcDraw: verifiable randomness for Arc",
    description: site.description,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "ArcDraw: verifiable randomness for Arc" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "ArcDraw: verifiable randomness for Arc",
    description: site.description,
    images: ["/og.png"],
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f3ec" },
    { media: "(prefers-color-scheme: dark)", color: "#101318" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-dvh overflow-x-hidden">
        <Providers>
          <SiteHeader />
          <main id="main">{children}</main>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
