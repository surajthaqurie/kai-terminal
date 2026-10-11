import { useEffect, useState } from 'react';
import { FALLBACK_TAG, LATEST_RELEASE_URL, REPO_URL } from '../data/site';

export type ReleaseAsset = { name: string; url: string; size: number };
export type LatestRelease = {
  tag: string;
  short: string;
  assets: ReleaseAsset[];
  asset: (match: (name: string) => boolean, fallbackFile: string) => string;
};

const REPO = 'surajthaqurie/kai-terminal';

function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch { return null; }
}

function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

/* Proactive: instant fallback render, then upgrade to live GitHub data.
   One fetch per hook, silent failure keeps fallback. */
export function useLatestRelease(): LatestRelease {
  const [data, setData] = useState<{ tag: string; assets: ReleaseAsset[] } | null>(() => load('kai-release'));
  useEffect(() => {
    fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j?.tag_name || !Array.isArray(j.assets) || j.assets.length === 0) return;
        const next = {
          tag: j.tag_name as string,
          assets: j.assets
            .filter((a: { name?: unknown; browser_download_url?: unknown }) => typeof a.name === 'string' && typeof a.browser_download_url === 'string')
            .map((a: { name: string; browser_download_url: string; size?: unknown }) => ({
              name: a.name,
              url: a.browser_download_url,
              size: typeof a.size === 'number' ? a.size : 0,
            })),
        };
        if (next.assets.length > 0) { setData(next); save('kai-release', next); }
      })
      .catch(() => {});
  }, []);
  const tag = data?.tag ?? FALLBACK_TAG;
  const short = tag.replace(/^v/, '');
  const assets = data?.assets ?? [];
  return {
    tag, short, assets,
    asset: (match, fallbackFile) =>
      assets.find((a) => match(a.name))?.url ?? `${REPO_URL}/releases/download/${tag}/${fallbackFile.replace('0.1.0', short)}`,
  };
}

export type PublishedRelease = { tag: string; name: string; date: string; url: string; notes: string };

export const FALLBACK_RELEASES: PublishedRelease[] = [
  {
    tag: 'v0.1.0',
    name: 'Kai v0.1.0 — First release',
    date: '2026-10-11T12:00:00Z',
    url: `${REPO_URL}/releases/tag/v0.1.0`,
    notes: 'First release of Kai:\n- Fast terminal for macOS, Linux and Windows\n- Smooth display, safe separate tabs\n- Help for your AI tools (Claude, Cursor, Codex, Gemini and more)\n- Private: nothing leaves your computer',
  },
];

export function usePublishedReleases(limit = 6): PublishedRelease[] {
  const [list, setList] = useState<PublishedRelease[]>(() => load<PublishedRelease[]>('kai-releases') ?? FALLBACK_RELEASES);
  useEffect(() => {
    fetch(`https://api.github.com/repos/${REPO}/releases?per_page=${limit}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!Array.isArray(j) || j.length === 0) return;
        const next = j
          .filter((r: { tag_name?: unknown }) => typeof r.tag_name === 'string')
          .slice(0, limit)
          .map((r: { tag_name: string; name?: unknown; published_at?: unknown; html_url?: unknown; body?: unknown }) => ({
            tag: r.tag_name,
            name: typeof r.name === 'string' && r.name ? r.name : r.tag_name,
            date: typeof r.published_at === 'string' ? r.published_at : '',
            url: typeof r.html_url === 'string' ? r.html_url : LATEST_RELEASE_URL,
            notes: typeof r.body === 'string' ? r.body : '',
          }));
        if (next.length > 0) { setList(next); save('kai-releases', next); }
      })
      .catch(() => {});
  }, [limit]);
  return list;
}

export function useRepoStars(): string | null {
  const [stars, setStars] = useState<string | null>(() => {
    try { return localStorage.getItem('kai-stars'); } catch { return null; }
  });
  useEffect(() => {
    fetch(`https://api.github.com/repos/${REPO}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (typeof j?.stargazers_count !== 'number') return;
        const n = j.stargazers_count as number;
        const label = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
        setStars(label);
        try { localStorage.setItem('kai-stars', label); } catch { /* ignore */ }
      })
      .catch(() => {});
  }, []);
  return stars;
}
