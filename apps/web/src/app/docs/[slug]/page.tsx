import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/markdown";
import { DOCS, readDoc } from "@/lib/docs";
import { repoFile } from "@/lib/site";

export const dynamicParams = false;

export function generateStaticParams() {
  return DOCS.map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const doc = DOCS.find((d) => d.slug === slug);
  return doc ? { title: doc.title, description: doc.summary } : {};
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = DOCS.find((d) => d.slug === slug);
  if (!doc) notFound();
  const source = readDoc(doc.file);
  return (
    <article className="max-w-3xl">
      <Markdown source={source} docFile={doc.file} />
      <p className="mt-12 border-t pt-4 text-xs text-muted-foreground">
        Rendered from{" "}
        <a className="underline underline-offset-4" href={repoFile(doc.file)} target="_blank" rel="noreferrer">
          {doc.file}
        </a>{" "}
        at build time.
      </p>
    </article>
  );
}
