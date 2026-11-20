/// <reference types="vitest/config" />
import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const YOUTUBE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TITLE_PATTERN = '"title":{"runs":[{"text":"';

interface YouTubeItem {
  videoId: string;
  title: string;
}

/**
 * Scrapes `{ videoId, title }` pairs out of a YouTube results/playlist page.
 * Dev-server only: mirrors the Rust `search_youtube_videos` command used by
 * the desktop build, so the music panel works under plain `vite`.
 */
function parseYouTubeItems(html: string, rendererPattern: string, limit: number): YouTubeItem[] {
  const vidPattern = html.includes(rendererPattern) ? rendererPattern : '"videoId":"';
  const items: YouTubeItem[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (items.length < limit) {
    const idx = html.indexOf(vidPattern, offset);
    if (idx === -1) break;
    const start = idx + vidPattern.length;
    const videoId = html.slice(start, start + 11);
    if (/^[\w-]{11}$/.test(videoId) && !seen.has(videoId)) {
      seen.add(videoId);
      const chunk = html.slice(start, start + 1500);
      const tIdx = chunk.indexOf(TITLE_PATTERN);
      const tEnd = tIdx === -1 ? -1 : chunk.indexOf('"', tIdx + TITLE_PATTERN.length);
      const title =
        tEnd === -1
          ? videoId
          : chunk
              .slice(tIdx + TITLE_PATTERN.length, tEnd)
              .replace(/\\u0026/g, '&')
              .replace(/\\"/g, '"');
      items.push({ videoId, title });
    }
    offset = start;
  }
  return items;
}

/** A mix's songs, read from a watch page's playlist panel (mirrors the Rust
 *  `extract_videos_from_mix_html`): mixes (`RD…`) have no playlist page. */
function parseMixItems(html: string, limit: number): YouTubeItem[] {
  const items: YouTubeItem[] = [];
  for (const entry of html.split('"playlistPanelVideoRenderer":{').slice(1)) {
    const videoId = /"videoId":"([\w-]{11})"/.exec(entry)?.[1];
    if (!videoId || items.some((i) => i.videoId === videoId)) continue;
    const raw = entry.startsWith('"title":{')
      ? /"simpleText":"((?:[^"\\]|\\.)*)"/.exec(entry)?.[1]
      : undefined;
    const title = raw?.replace(/\\u0026/g, '&').replace(/\\"/g, '"').trim();
    items.push({ videoId, title: title || videoId });
    if (items.length >= limit) break;
  }
  return items;
}

async function fetchMixItems(listId: string, seed: string | null, limit: number) {
  const derived = /^RD(?:AMVM)?([\w-]{11})$/.exec(listId)?.[1];
  const v = seed ?? derived;
  const url = `https://www.youtube.com/watch?${v ? `v=${v}&` : ''}list=${encodeURIComponent(listId)}`;
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': YOUTUBE_USER_AGENT } });
    return parseMixItems(await resp.text(), limit);
  } catch {
    return [];
  }
}

async function fetchYouTubeItems(
  url: string,
  rendererPattern: string,
  limit: number
): Promise<YouTubeItem[]> {
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': YOUTUBE_USER_AGENT } });
    return parseYouTubeItems(await resp.text(), rendererPattern, limit);
  } catch {
    return [];
  }
}

function youtubeMediaPlugin(): Plugin {
  return {
    name: 'youtube-media-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '', `http://${req.headers.host || 'localhost'}`);
        const respond = (items: YouTubeItem[]) => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(items));
        };

        // Suggestions: /api/youtube-search?q=<words>
        if (url.pathname.startsWith('/api/youtube-search')) {
          const q = url.searchParams.get('q')?.trim();
          return respond(
            q
              ? await fetchYouTubeItems(
                  `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
                  '"videoRenderer":{"videoId":"',
                  8
                )
              : []
          );
        }

        // Playlist items: /api/youtube-playlist?list=<id>
        if (url.pathname.startsWith('/api/youtube-playlist')) {
          const listId = url.searchParams.get('list')?.trim();
          const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit') ?? '24', 10) || 24));
          if (!listId || !/^[A-Za-z0-9_-]{10,64}$/.test(listId)) return respond([]);
          const v = url.searchParams.get('v');
          const seed = v && /^[\w-]{11}$/.test(v) ? v : null;
          const mix = listId.startsWith('RD') ? await fetchMixItems(listId, seed, limit) : [];
          return respond(
            mix.length > 0
              ? mix
              : await fetchYouTubeItems(
                  `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`,
                  '"playlistVideoRenderer":{"videoId":"',
                  limit
                )
          );
        }

        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), youtubeMediaPlugin()],
  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    host: '0.0.0.0',
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  test: {
    exclude: ['**/node_modules/**', '**/.git/**', 'scripts/**/*.live.test.ts'],
    // Never touch the developer's real ~/.kai (see the helper).
    setupFiles: ['src/__tests__/helpers/isolateKaiHome.ts'],
    // Lock-contention and crash-recovery tests block synchronously for ~6 s by
    // design (bounded retry loops); Vitest 5 enforces the timeout on elapsed
    // time even for synchronous blocking, so the 5 s default is too tight.
    testTimeout: 30000,
  },
});
