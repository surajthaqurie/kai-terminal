import { SITE_URL } from '../data/site';

export const ROUTE_META: Record<string, { title: string; description: string }> = {
  '/': {
    title: 'Kai — Fast, GPU-Accelerated Terminal for AI Coding Agents',
    description: 'Hardware-accelerated terminal for macOS, Linux, and Windows with a native local project intelligence engine for AI agents.',
  },
  '/download': {
    title: 'Download Kai — macOS, Linux, Windows',
    description: 'Native packages for macOS (.dmg), Linux (.deb, .AppImage), and Windows (.exe, .msi). Free and MIT licensed.',
  },
  '/changelog': {
    title: "What's new in Kai — Changelog",
    description: 'Release history, changelog entries, and version notes.',
  },
  '/guide': {
    title: 'Getting started with Kai — Guide',
    description: 'Install Kai, start your first session, and connect AI coding agents.',
  },
  '/commands': {
    title: 'Commands — Kai',
    description: 'Every Kai command, grouped by topic.',
  },
  '/mcp': {
    title: 'MCP reference — Kai',
    description: 'Local MCP server: start command and tool reference.',
  },
  '/docs': {
    title: 'Docs — Kai',
    description: 'Every doc rendered from its markdown source on GitHub.',
  },
  '/faq': {
    title: 'Frequently asked questions — Kai',
    description: 'What Kai is, what it costs, how to start, and which files to download.',
  },
  '/404': {
    title: 'Page not found — Kai',
    description: 'That Kai page does not exist. Try Home, Download, Guide or Manual.',
  },
};

export function canonicalFor(path: string): string {
  // Legacy /manual now lives at /commands.
  const canonicalPath = path === '/manual' ? '/commands' : path;
  return `${SITE_URL}${canonicalPath === '/' ? '/' : canonicalPath}`;
}
