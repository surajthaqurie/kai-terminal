import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

/* Minimal client-side router (no dependency).
   Clean URLs via History API: /, /download, /changelog, /guide, /faq.
   Vercel rewrites /(.*) -> /index.html so deep links + refresh work.
   Hash suffixes (/#features, /guide#shortcuts) are preserved for scrolling. */

export const ROUTES = ['/', '/download', '/changelog', '/guide', '/faq'] as const;
export type RoutePath = (typeof ROUTES)[number];

export const ROUTE_META: Record<string, { title: string; description: string }> = {
  '/': {
    title: 'kai — One terminal. Every platform.',
    description: 'kai is a fast, keyboard-first terminal for Windows, Linux and macOS. Native Rust PTY, GPU render, local AI CLIs. Free, MIT, zero telemetry.',
  },
  '/download': {
    title: 'Download kai — Windows, Linux, macOS',
    description: 'Get native kai builds: Windows .exe/.msi, Linux .deb/.AppImage, macOS .dmg. Free MIT, zero telemetry, built on GitHub Actions.',
  },
  '/changelog': {
    title: 'Changelog — kai releases',
    description: 'Every kai release plus pending unreleased changes, synced automatically from GitHub Releases and changesets.',
  },
  '/guide': {
    title: 'Guide — get started with kai in 30 seconds',
    description: 'Install kai, verify the engine, plug in Codex / Claude / Gemini CLIs, and learn the keyboard-first shortcuts.',
  },
  '/faq': {
    title: 'FAQ — kai questions answered',
    description: 'Is kai free? Any telemetry? How does AI work? Which OS builds are shipped? Answers here.',
  },
};

function pathname(): string {
  try {
    let p = window.location.pathname || '/';
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p;
  } catch {
    return '/';
  }
}

export function navigate(to: string) {
  window.history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

const PathContext = createContext<string>('/');

export function RouterProvider({ children }: { children: React.ReactNode }) {
  const [path, setPath] = useState<string>(() => (typeof window === 'undefined' ? '/' : pathname()));
  useEffect(() => {
    const onChange = () => setPath(pathname());
    window.addEventListener('popstate', onChange);
    return () => window.removeEventListener('popstate', onChange);
  }, []);
  return <PathContext.Provider value={path}>{children}</PathContext.Provider>;
}

export function usePath(): string {
  return useContext(PathContext);
}

export function useNavigate() {
  return useCallback((to: string) => navigate(to), []);
}

function isExternal(to: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(to) || to.startsWith('//');
}

export function Link({
  to,
  children,
  className,
  style,
  onClick,
  activeClass = 'is-active',
  ...rest
}: {
  to: string;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  onClick?: (e: React.MouseEvent) => void;
  activeClass?: string;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'>) {
  const path = usePath();
  const active = !isExternal(to) && (to === path || (to !== '/' && path.startsWith(to)));
  return (
    <a
      href={to}
      className={active && className ? `${className} ${activeClass}` : className}
      aria-current={active ? 'page' : undefined}
      style={style}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        if (isExternal(to) || to.startsWith('#')) return;
        e.preventDefault();
        if (to !== window.location.pathname + window.location.hash) navigate(to);
        else window.scrollTo({ top: 0 });
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

/** Scroll to top on page change; honour #hash targets when present. */
export function useRouteScroll() {
  const path = usePath();
  useEffect(() => {
    const hash = window.location.hash;
    if (hash) {
      const el = document.querySelector(hash);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }
    window.scrollTo(0, 0);
  }, [path]);
}

/** Keep <title> + meta description in sync per route (professional SEO). */
export function useRouteMeta() {
  const path = usePath();
  useEffect(() => {
    const meta = ROUTE_META[path];
    if (meta) {
      document.title = meta.title;
      const desc = document.querySelector('meta[name="description"]');
      if (desc) desc.setAttribute('content', meta.description);
    }
  }, [path]);
}
