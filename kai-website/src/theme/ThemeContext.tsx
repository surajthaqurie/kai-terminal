'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export type Theme = 'dark' | 'light';

const KEY = 'kai-theme';

function readStored(): Theme {
  // Client-only: read after mount so the first client render matches SSR.
  try {
    const s = localStorage.getItem(KEY);
    if (s === 'light' || s === 'dark') return s;
  } catch { /* ignore */ }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

const Ctx = createContext<{ theme: Theme; toggle: () => void }>({ theme: 'dark', toggle: () => {} });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Fixed 'dark' initial so SSR HTML and the first client render agree —
  // the inline <head> script already painted the right theme pre-hydration.
  // Stored/OS preference is applied in an effect (no hydration mismatch).
  const [theme, setTheme] = useState<Theme>('dark');
  const synced = useRef(false);
  useEffect(() => {
    // Mount: adopt the theme the <head> script painted (stored or OS).
    // Skip the DOM write — paint is already correct, so no flash.
    if (!synced.current) {
      synced.current = true;
      setTheme(readStored());
      return;
    }
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try { localStorage.setItem(KEY, theme); } catch { /* ignore */ }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#111318' : '#f8fafc');
  }, [theme]);

  // Keep in sync if OS preference changes and user never chose manually
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: light)');
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => {
      try {
        if (localStorage.getItem(KEY)) return;
      } catch { /* ignore */ }
      setTheme(e.matches ? 'light' : 'dark');
    };
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  return <Ctx.Provider value={{ theme, toggle }}>{children}</Ctx.Provider>;
}

export function useTheme() {
  return useContext(Ctx);
}
