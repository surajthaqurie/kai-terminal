/// <reference types="vitest/config" />
import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';

function youtubeMediaPlugin(): Plugin {
  return {
    name: 'youtube-media-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        // -------- Suggestions: /api/youtube-search?q=<words> --------
        if (!req.url?.startsWith('/api/youtube-search')) {
          if (!req.url?.startsWith('/api/youtube-playlist')) {
            return next();
          }
          // -------- Playlist items: /api/youtube-playlist?list=<id> --------
          const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
          const listId = url.searchParams.get('list')?.trim();
          const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit') ?? '24', 10) || 24));
          res.setHeader('Content-Type', 'application/json');
          if (!listId || !/^[A-Za-z0-9_-]{10,64}$/.test(listId)) {
            res.end(JSON.stringify([]));
            return;
          }
          try {
            const resp = await fetch(`https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`, {
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              },
            });
            const html = await resp.text();
            const items: { videoId: string; title: string }[] = [];
            const seen = new Set<string>();
            const rendererPattern = '"playlistVideoRenderer":{"videoId":"';
            const fallbackVidPattern = '"videoId":"';
            const vidPattern = html.includes(rendererPattern) ? rendererPattern : fallbackVidPattern;
            const titlePattern = '"title":{"runs":[{"text":"';
            let offset = 0;
            while (true) {
              const idx = html.indexOf(vidPattern, offset);
              if (idx === -1) break;
              const start = idx + vidPattern.length;
              const candidate = html.slice(start, start + 11);
              if (/^[\w-]{11}$/.test(candidate) && !seen.has(candidate)) {
                seen.add(candidate);
                const chunk = html.slice(start, start + 1500);
                const tIdx = chunk.indexOf(titlePattern);
                let title = candidate;
                if (tIdx !== -1) {
                  const tStart = tIdx + titlePattern.length;
                  const tEnd = chunk.indexOf('"', tStart);
                  if (tEnd !== -1) {
                    title = chunk.slice(tStart, tEnd).replace(/\\u0026/g, '&').replace(/\\"/g, '"');
                  }
                }
                items.push({ videoId: candidate, title });
                if (items.length >= limit) break;
              }
              offset = start;
            }
            res.end(JSON.stringify(items));
          } catch {
            res.end(JSON.stringify([]));
          }
          return;
        }
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const q = url.searchParams.get('q')?.trim();
        if (!q) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify([]));
          return;
        }

        try {
          const resp = await fetch(
            `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
            {
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              },
            }
          );
          const html = await resp.text();
          const items: { videoId: string; title: string }[] = [];
          const seen = new Set<string>();
          const vidRendererPattern = '"videoRenderer":{"videoId":"';
          const fallbackVidPattern = '"videoId":"';
          const vidPattern = html.includes(vidRendererPattern)
            ? vidRendererPattern
            : fallbackVidPattern;
          const titlePattern = '"title":{"runs":[{"text":"';
          let offset = 0;
          while (true) {
            const idx = html.indexOf(vidPattern, offset);
            if (idx === -1) break;
            const start = idx + vidPattern.length;
            const candidate = html.slice(start, start + 11);
            if (/^[\w-]{11}$/.test(candidate)) {
              if (!seen.has(candidate)) {
                seen.add(candidate);
                const chunk = html.slice(start, start + 1500);
                const tIdx = chunk.indexOf(titlePattern);
                let title = candidate;
                if (tIdx !== -1) {
                  const tStart = tIdx + titlePattern.length;
                  const tEnd = chunk.indexOf('"', tStart);
                  if (tEnd !== -1) {
                    title = chunk
                      .slice(tStart, tEnd)
                      .replace(/\\u0026/g, '&')
                      .replace(/\\"/g, '"');
                  }
                }
                items.push({ videoId: candidate, title });
                if (items.length >= 8) break;
              }
            }
            offset = start;
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(items));
        } catch {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify([]));
        }
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
    // Lock-contention and crash-recovery tests block synchronously for ~6 s by
    // design (bounded retry loops); Vitest 5 enforces the timeout on elapsed
    // time even for synchronous blocking, so the 5 s default is too tight.
    testTimeout: 30000,
  },
});
