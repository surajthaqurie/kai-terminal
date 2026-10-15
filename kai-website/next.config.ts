import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Static export keeps Vercel + GitHub Pages style hosting simple and every
  // route crawlable as plain HTML. Client islands (search, terminal, theme)
  // still hydrate in the browser.
  images: { unoptimized: true },
  // Silence turbopack root inference when Vercel builds from repo root.
  turbopack: { root: __dirname },
};

export default nextConfig;
