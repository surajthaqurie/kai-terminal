import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

const KEY = 'kai-theme';

function initial(): Theme {
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
  const [theme, setTheme] = useState<Theme>(initial);
  useEffect(() => {
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
