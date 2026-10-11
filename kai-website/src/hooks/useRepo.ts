import { useEffect, useState } from 'react';
import { readCache, writeCache } from '../lib/cache';
import { FALLBACK_TAG, LATEST_RELEASE_URL, REPO_URL } from '../data/site';

export type ReleaseAsset = { name: string; url: string; size: number; downloads: number };
export type ReleaseStatus = 'loading' | 'ready' | 'empty';

export type LatestRelease = {
  tag: string;
  short: string;
  assets: ReleaseAsset[];
  status: ReleaseStatus;
  asset: (match: (name: string) => boolean, fallbackFile: string) => string;
};

export function useLatestRelease(): LatestRelease {
  const [rel, setRel] = useState<{ tag: string; assets: ReleaseAsset[] } | 'empty' | null>(() => {
    const cached = readCache('kai-release');
    if (!cached) return null;
    try {
      const parsed = JSON.parse(cached) as { tag: string; assets: ReleaseAsset[] };
      if (typeof parsed.tag !== 'string' || !Array.isArray(parsed.assets)) return null;
      const assets = parsed.assets
        .filter((a) => a && typeof a.name === 'string' && typeof a.url === 'string')
        .map((a) => ({
          name: a.name,
          url: a.url,
          size: typeof a.size === 'number' ? a.size : 0,
          downloads: typeof a.downloads === 'number' ? a.downloads : 0,
        }));
      return { tag: parsed.tag, assets };
    } catch {
      /* corrupt cache — refetch below */
    }
    return null;
  });
  useEffect(() => {
    let live = true;
    fetch('https://api.github.com/repos/surajthaqurie/kai-terminal/releases/latest')
      .then((r) => {
        if (r.status === 404) return 'missing';
        return r.ok ? r.json() : null;
      })
      .then((j) => {
        if (!live) return;
        if (j === 'missing' || !j || typeof j.tag_name !== 'string') {
          setRel((prev) => (prev ? prev : 'empty'));
          return;
        }
        const assets: ReleaseAsset[] = Array.isArray(j.assets)
          ? j.assets
            .filter((a: any) => a && typeof a.name === 'string' && typeof a.browser_download_url === 'string')
            .filter((a: any) => !(a.name as string).toLowerCase().endsWith('.sig'))
            .map((a: any) => ({
              name: a.name as string,
              url: a.browser_download_url as string,
              size: typeof a.size === 'number' ? a.size : 0,
              downloads: typeof a.download_count === 'number' ? a.download_count : 0,
            }))
          : [];
        if (assets.length === 0) {
          setRel((prev) => (prev && prev !== 'empty' ? prev : 'empty'));
          return;
        }
        const next = { tag: j.tag_name as string, assets };
        setRel(next);
        writeCache('kai-release', JSON.stringify(next));
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  const data = rel === 'empty' ? null : rel;
  const tag = data?.tag ?? FALLBACK_TAG;
  const short = tag.replace(/^v/, '');
  const assets = data?.assets ?? [];
  const status: ReleaseStatus = data ? 'ready' : rel === 'empty' ? 'empty' : 'loading';
  const asset = (match: (name: string) => boolean, fallbackFile: string) => {
    const hit = assets.find((a) => match(a.name));
    if (hit) return hit.url;
    return `${REPO_URL}/releases/download/${tag}/${fallbackFile.replace('0.1.0', short)}`;
  };
  return { tag, short, assets, status, asset };
}

export type PublishedRelease = {
  tag: string;
  name: string;
  date: string;
  url: string;
  notes: string;
};

export const FALLBACK_RELEASES: PublishedRelease[] = [
  {
    tag: 'v0.1.0',
    name: 'Kai v0.1.0 — Initial Production Release',
    date: '2026-10-11T12:00:00Z',
    url: `${REPO_URL}/releases/tag/v0.1.0`,
    notes:
      'Initial production release of Kai:\n- Native portable-pty core: ConPTY on Windows, POSIX pseudoterminals on macOS & Linux with sub-millisecond ANSI throughput.\n- GPU canvas rendering: xterm.js canvas engine delivering smooth 60fps rendering at ~30MB idle RAM.\n- Project Intelligence & MCP: AST symbol graph indexing, deterministic retrieval (<10ms, ~70% token savings), and stdio MCP server for Claude Code, Cursor, Codex, Gemini, Copilot, Windsurf & Cline.\n- Structured cross-platform releases: Apple Silicon macOS DMG, Linux x64/ARM64 DEB & portable AppImage, and Windows x64 NSIS Setup & MSI.\n- Audited security release gate: strict workspace confinement, secret scrubbing, symlink boundary verification, and zero telemetry.',
  },
];

export function usePublishedReleases(limit = 6): PublishedRelease[] {
  const [list, setList] = useState<PublishedRelease[]>(() => {
    const cached = readCache('kai-releases');
    if (!cached) return FALLBACK_RELEASES;
    try {
      const parsed = JSON.parse(cached) as PublishedRelease[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed.filter((r) => r && typeof r.tag === 'string');
    } catch {
      /* corrupt cache — refetch below */
    }
    return FALLBACK_RELEASES;
  });
  useEffect(() => {
    let live = true;
    fetch(`https://api.github.com/repos/surajthaqurie/kai-terminal/releases?per_page=${limit}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!live || !Array.isArray(j) || j.length === 0) return;
        const next: PublishedRelease[] = j
          .filter((r: any) => r && typeof r.tag_name === 'string')
          .slice(0, limit)
          .map((r: any) => ({
            tag: r.tag_name as string,
            name: typeof r.name === 'string' && r.name ? r.name : (r.tag_name as string),
            date: typeof r.published_at === 'string' ? r.published_at : '',
            url: typeof r.html_url === 'string' ? r.html_url : LATEST_RELEASE_URL,
            notes: typeof r.body === 'string' ? r.body : '',
          }));
        if (next.length > 0) {
          setList(next);
          writeCache('kai-releases', JSON.stringify(next));
        }
      })
      .catch(() => {});
    return () => { live = false; };
  }, [limit]);
  return list;
}

export function useRepoStars(): string | null {
  const [stars, setStars] = useState<string | null>(() => readCache('kai-stars'));
  useEffect(() => {
    let live = true;
    fetch('https://api.github.com/repos/surajthaqurie/kai-terminal')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!live || !j || typeof j.stargazers_count !== 'number') return;
        const n: number = j.stargazers_count;
        const label = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
        setStars(label);
        writeCache('kai-stars', label);
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return stars;
}
