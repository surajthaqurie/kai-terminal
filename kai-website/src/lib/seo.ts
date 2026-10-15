import type { Metadata } from 'next';
import { SITE_URL } from '../data/site';
import { ROUTE_META, canonicalFor } from '../lib/routes';

export function metadataFor(path: string): Metadata {
  const meta = ROUTE_META[path] ?? ROUTE_META['/404'];
  const canonical = canonicalFor(path);
  return {
    title: meta.title,
    description: meta.description,
    alternates: { canonical },
    openGraph: {
      title: meta.title,
      description: meta.description,
      url: canonical,
      siteName: 'Kai',
      type: 'website',
      images: [{ url: `${SITE_URL}/og.png`, width: 1200, height: 630, alt: 'Kai terminal' }],
    },
    twitter: {
      card: 'summary_large_image',
      title: meta.title,
      description: meta.description,
      images: [`${SITE_URL}/og.png`],
    },
  };
}

export function jsonLdWebsite() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Kai',
    url: SITE_URL,
  };
}

export function jsonLdSoftware() {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Kai Terminal',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Linux, Windows',
    url: SITE_URL,
    license: 'https://github.com/surajthaqurie/kai-terminal/blob/main/LICENSE',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  };
}

export function jsonLdFaq(items: Array<{ q: string; a: string }>) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((i) => ({
      '@type': 'Question',
      name: i.q,
      acceptedAnswer: { '@type': 'Answer', text: i.a },
    })),
  };
}
