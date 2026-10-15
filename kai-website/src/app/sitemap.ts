import type { MetadataRoute } from 'next';
import { SITE_URL } from '../data/site';
import { DOCS } from '../data/docs';
import { getServerReleases } from '../lib/release';

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const staticRoutes = [
    { path: '/', priority: 1.0, changeFrequency: 'weekly' as const },
    { path: '/download', priority: 0.9, changeFrequency: 'weekly' as const },
    { path: '/guide', priority: 0.8, changeFrequency: 'weekly' as const },
    { path: '/commands', priority: 0.8, changeFrequency: 'weekly' as const },
    { path: '/mcp', priority: 0.7, changeFrequency: 'monthly' as const },
    { path: '/changelog', priority: 0.7, changeFrequency: 'weekly' as const },
    { path: '/docs', priority: 0.6, changeFrequency: 'weekly' as const },
    { path: '/faq', priority: 0.6, changeFrequency: 'monthly' as const },
  ];
  const releases = getServerReleases(20);
  const changelogDate = releases[0]?.date ? new Date(releases[0].date) : now;
  const entries: MetadataRoute.Sitemap = staticRoutes.map((r) => ({
    url: `${SITE_URL}${r.path === '/' ? '/' : r.path}`,
    lastModified: r.path === '/changelog' ? changelogDate : now,
    changeFrequency: r.changeFrequency,
    priority: r.priority,
  }));
  for (const d of DOCS) {
    if (d.slug === 'manual' || d.slug === 'mcp') continue;
    entries.push({
      url: `${SITE_URL}/docs/${d.slug}`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.5,
    });
  }
  return entries;
}
