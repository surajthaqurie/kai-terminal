import React, { createContext, useContext, useEffect, useState } from 'react';
import { SITE_URL } from './data/site';

/* Simple hash-free router: History API + Vercel rewrite to /index.html. */

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
    title: 'Changelog — Kai',
    description: 'Release history, changelog entries, and version notes.',
  },
  '/guide': {
    title: 'Getting Started — Kai Developer Guide',
    description: 'Step-by-step onboarding guide to install Kai, start your first session, and connect AI coding agents.',
  },
  '/manual': {
    title: 'User Manual & Command Reference — Kai',
    description: 'Complete technical reference: environment boundaries, external host commands, agent workflows, and cheatsheet.',
  },
  '/docs': {
    title: 'Documentation — Kai',
    description: 'Architecture, installation, security, and developer documentation rendered directly from the source repository.',
  },
  '/faq': {
    title: 'FAQ — Kai',
    description: 'What Kai is, what it costs, how to start, and which files to download.',
  },
  '/404': {
    title: 'Page not found — Kai',
    description: 'That Kai page does not exist. Try Home, Download, Docs or Manual.',
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
  // Exact match, or parent match on segment boundary (/docs matches /docs/x, not /download).
  const active = !external(to) && !to.startsWith('#') && (to === path || (to !== '/' && path.startsWith(to.endsWith('/') ? to : `${to}/`)));
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
    // Strip leading # and decode; ignore empty hashes.
    const id = hash ? decodeURIComponent(hash.slice(1)) : '';
    const el = id ? document.getElementById(id) : null;
    if (el) {
      // Defer one frame so the freshly rendered doc sections exist.
      requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    } else {
      window.scrollTo(0, 0);
    }
  }, [path]);
  // Same-page anchor clicks (e.g. DocView TOC) don't change path — listen for hash.
  useEffect(() => {
    const onHash = () => {
      const id = decodeURIComponent((window.location.hash || '').slice(1));
      if (!id) return;
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
}

export function useRouteMeta() {
  const path = usePath();
  useEffect(() => {
    // /docs/<slug> shares the /docs meta; unknown routes get the 404 meta.
    const key = path.startsWith('/docs/') ? '/docs' : path;
    const meta = ROUTE_META[key] ?? ROUTE_META['/404'];
    const url = `${SITE_URL}${path === '/' ? '/' : path}`;
    document.title = meta.title;
    document.querySelector('meta[name="description"]')?.setAttribute('content', meta.description);
    document.querySelector('link[rel="canonical"]')?.setAttribute('href', url);
    document.querySelector('meta[property="og:url"]')?.setAttribute('content', url);
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', meta.title);
    document.querySelector('meta[property="og:description"]')?.setAttribute('content', meta.description);
  }, [path]);
}
