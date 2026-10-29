'use client';

import { useEffect, useState } from 'react';
import { FALLBACK_TAG, LATEST_RELEASE_URL, REPO_URL } from '../data/site';
import releaseInfo from '../data/release.json';

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

type LiveRelease = { tag: string; assets: ReleaseAsset[] };

/* One request per page load, shared by every component that asks (Hero and
   Downloads both mount on the home page; unauthenticated GitHub API calls are
   rate-limited per IP). */
let latestInflight: Promise<LiveRelease | null> | null = null;

function fetchLatestRelease(): Promise<LiveRelease | null> {
  latestInflight ??= fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j): LiveRelease | null => {
      if (!j?.tag_name || !Array.isArray(j.assets) || j.assets.length === 0) return null;
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
      return next.assets.length > 0 ? next : null;
    })
    .catch(() => null);
  return latestInflight;
}

/* Proactive: fallback render (matches SSR), then upgrade to cached live data,
   then to fresh GitHub data. Cache is read in an effect so the first client
   render always agrees with the server HTML — no hydration mismatch. */
export function useLatestRelease(): LatestRelease {
  const [data, setData] = useState<LiveRelease | null>(null);
  useEffect(() => {
    setData(load('kai-release'));
    void fetchLatestRelease().then((next) => {
      if (next) { setData(next); save('kai-release', next); }
    });
  }, []);
  const tag = data?.tag ?? FALLBACK_TAG;
  const short = tag.replace(/^v/, '');
  const assets = data?.assets ?? [];
  return {
    tag, short, assets,
    asset: (match, fallbackFile) =>
      assets.find((a) => match(a.name))?.url ?? `${REPO_URL}/releases/download/${tag}/${fallbackFile.includes(short) ? fallbackFile : fallbackFile.replace(/\d+\.\d+\.\d+/, short)}`,
  };
}

/* The server-rendered release comes from release.json, which is bumped as soon
   as the version is committed — before CI has published that tag's installers.
   Links built from it 404 in that window, so the client swaps in the latest
   release GitHub actually serves (tag, assets and sizes). Until the live data
   arrives (or if the API is unreachable) the server release is kept as-is. */
export function useResolvedRelease(server: { tag: string; short: string; assets: ReleaseAsset[] }) {
  const live = useLatestRelease();
  return live.assets.length > 0
    ? { tag: live.tag, short: live.short, assets: live.assets }
    : server;
}

export type PublishedRelease = { tag: string; name: string; date: string; url: string; notes: string };

export const FALLBACK_RELEASES: PublishedRelease[] = releaseInfo.releases;

export function usePublishedReleases(limit = 6): PublishedRelease[] {
  const [list, setList] = useState<PublishedRelease[]>(FALLBACK_RELEASES);
  useEffect(() => {
    const cached = load<PublishedRelease[]>('kai-releases');
    if (cached) setList(cached);
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
  const [stars, setStars] = useState<string | null>(null);
  useEffect(() => {
    try {
      const cached = localStorage.getItem('kai-stars');
      if (cached) setStars(cached);
    } catch { /* ignore */ }
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
