'use client';

import React, { useEffect } from 'react';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { SITE_URL } from './data/site';

export { ROUTE_META, canonicalFor } from './lib/routes';

/* Next.js App Router compatibility shim.
   Keeps the old `<Link to="">` API working while rendering next/link
   underneath so navigation stays client-side and prefetchable. */

export { SITE_URL };

function external(to: string) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(to) || to.startsWith('//');
}

// No-op provider kept so old App.tsx imports keep compiling during migration.
export function RouterProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export function usePath() {
  return usePathname() ?? '/';
}

export function Link({ to, children, className, style, onClick, ...rest }: {
  to: string; children: React.ReactNode; className?: string;
  style?: React.CSSProperties; onClick?: React.MouseEventHandler<HTMLAnchorElement>;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'>) {
  const path = usePath();
  if (external(to) || to.startsWith('#')) {
    return <a href={to} className={className} style={style} onClick={onClick} {...rest}>{children}</a>;
  }
  const active = to === path || (to !== '/' && path.startsWith(to.endsWith('/') ? to : `${to}/`));
  return (
    <NextLink
      href={to}
      className={active ? (className ? `${className} is-active` : 'is-active') : className}
      aria-current={active ? 'page' : undefined}
      style={style}
      onClick={onClick}
      {...rest}
    >
      {children}
    </NextLink>
  );
}

export function useRouteScroll() {
  const path = usePath();
  useEffect(() => {
    const hash = window.location.hash;
    const id = hash ? decodeURIComponent(hash.slice(1)) : '';
    const el = id ? document.getElementById(id) : null;
    if (el) {
      requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    } else {
      window.scrollTo(0, 0);
    }
  }, [path]);
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

// Per-route <title>/meta/canonical> are now emitted server-side via Next
// generateMetadata. This hook is a no-op kept for old imports.
export function useRouteMeta() {}
