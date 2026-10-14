import React, { createContext, useContext, useEffect, useState } from 'react';
import { SITE_URL } from './data/site';

/* Simple hash-free router: History API + Vercel rewrite to /index.html. */

export const ROUTE_META: Record<string, { title: string; description: string }> = {
  '/': {
    title: 'Kai — Terminal for macOS, Linux, Windows',
    description: 'Kai is a Tauri + Rust terminal with a local CLI for AI context. MIT licensed. Installers on GitHub Releases.',
  },
  '/download': {
    title: 'Download Kai — macOS, Linux, Windows',
    description: 'All Kai installers: macOS .dmg, Linux .deb/.AppImage, Windows .exe/.msi. Pick your own file on GitHub Releases.',
  },
  '/changelog': {
    title: 'Changelog — Kai',
    description: 'Kai release notes and pending changes.',
  },
  '/guide': {
    title: 'Setup guide — Kai',
    description: 'Install Kai, open your project, and run your favorite AI coding agent with auto MCP wiring.',
  },
  '/manual': {
    title: 'User Manual & Command Reference — Kai',
    description: 'Comprehensive user manual, environment boundaries, CLI commands, agent workflows, and cheatsheet for Kai Terminal.',
  },
  '/faq': {
    title: 'FAQ — Kai',
    description: 'What Kai is, what it costs, how to start, and which files to download.',
  },
};

function pathname(): string {
  let p = window.location.pathname || '/';
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

export function navigate(to: string) {
  window.history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

const PathCtx = createContext('/');

export function RouterProvider({ children }: { children: React.ReactNode }) {
  const [path, setPath] = useState(() => (typeof window === 'undefined' ? '/' : pathname()));
  useEffect(() => {
    const onChange = () => setPath(pathname());
    window.addEventListener('popstate', onChange);
    return () => window.removeEventListener('popstate', onChange);
  }, []);
  return <PathCtx.Provider value={path}>{children}</PathCtx.Provider>;
}

export function usePath() {
  return useContext(PathCtx);
}

function external(to: string) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(to) || to.startsWith('//');
}

export function Link({ to, children, className, style, onClick, ...rest }: {
  to: string; children: React.ReactNode; className?: string;
  style?: React.CSSProperties; onClick?: React.MouseEventHandler<HTMLAnchorElement>;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'>) {
  const path = usePath();
  const active = !external(to) && (to === path || (to !== '/' && path.startsWith(to)));
  return (
    <a
      href={to}
      className={active && className ? `${className} is-active` : className}
      aria-current={active ? 'page' : undefined}
      style={style}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        if (external(to) || to.startsWith('#')) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

export function useRouteScroll() {
  const path = usePath();
  useEffect(() => {
    const hash = window.location.hash;
    const el = hash ? document.querySelector(hash) : null;
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else window.scrollTo(0, 0);
  }, [path]);
}

export function useRouteMeta() {
  const path = usePath();
  useEffect(() => {
    const meta = ROUTE_META[path];
    if (!meta) return;
    const url = `${SITE_URL}${path === '/' ? '/' : path}`;
    document.title = meta.title;
    document.querySelector('meta[name="description"]')?.setAttribute('content', meta.description);
    document.querySelector('link[rel="canonical"]')?.setAttribute('href', url);
    document.querySelector('meta[property="og:url"]')?.setAttribute('content', url);
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', meta.title);
    document.querySelector('meta[property="og:description"]')?.setAttribute('content', meta.description);
  }, [path]);
}
