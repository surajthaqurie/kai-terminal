import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { DocDetailPage } from '../../../views/Docs';
import { DOCS, getDoc } from '../../../data/docs';
import { SITE_URL } from '../../../data/site';

export function generateStaticParams() {
  return DOCS.filter((d) => d.slug !== 'manual' && d.slug !== 'mcp').map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const doc = getDoc(slug);
  if (!doc) return { title: 'Doc not found — Kai' };
  const canonical = slug === 'manual' ? `${SITE_URL}/commands` : slug === 'mcp' ? `${SITE_URL}/mcp` : `${SITE_URL}/docs/${slug}`;
  const title = `${doc.heading || doc.title} — Kai Docs`;
  return {
    title,
    description: doc.desc,
    alternates: { canonical },
    openGraph: {
      title,
      description: doc.desc,
      url: canonical,
      type: 'article',
      images: [{ url: `${SITE_URL}/og.png`, width: 1200, height: 630, alt: doc.title }],
    },
    twitter: { card: 'summary_large_image', title, description: doc.desc },
  };
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (slug === 'manual') {
    // Canonical lives at /commands.
    redirect('/commands');
  }
  if (slug === 'mcp') {
    redirect('/mcp');
  }
  const doc = getDoc(slug);
  if (!doc) notFound();
  return <DocDetailPage slug={slug} />;
}
