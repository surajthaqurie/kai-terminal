import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

/* Minimal client-side router (no dependency).
   Clean URLs via History API: /, /download, /changelog, /guide, /faq.
   Vercel rewrites /(.*) -> /index.html so deep links + refresh work.
   Hash suffixes (/#features, /guide#shortcuts) are preserved for scrolling. */

export const ROUTES = ['/', '/download', '/changelog', '/guide', '/faq'] as const;
export type RoutePath = (typeof ROUTES)[number];

export const ROUTE_META: Record<string, { title: string; description: string }> = {
  '/': {
    title: 'Kai — Simple fast terminal for everyone',
    description: 'Kai is a simple, fast terminal for Windows, Linux and Mac. Easy setup in 30 seconds. Works with your AI tools. Free and private.',
  },
  '/download': {
    title: 'Download Kai — Free for Windows, Linux, Mac',
    description: 'Download Kai for your system in 30 seconds. Simple setup, free forever, private by design.',
  },
  '/changelog': {
    title: "What's new — Kai updates",
    description: 'See the latest Kai improvements and fixes in simple words. Newest first.',
  },
  '/guide': {
    title: 'Kai Guide — Start in 30 seconds',
    description: 'Learn Kai in 3 simple steps: install, open a project, connect your AI tool. No account needed.',
  },
  '/faq': {
    title: 'Kai FAQ — Simple answers',
    description: 'Is Kai free? Is my code safe? How do I start? Simple answers to common questions.',
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
