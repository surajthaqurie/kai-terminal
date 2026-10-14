import { ThemeProvider } from './theme/ThemeContext';
import { RouterProvider, usePath, useRouteMeta, useRouteScroll } from './router';
import { useLatestRelease } from './hooks/useRepo';
import { SiteHeader } from './components/Header';
import { HomePage } from './pages/Home';
import { DownloadPage } from './pages/Download';
import { ChangelogPage } from './pages/Changelog';
import { GuidePage } from './pages/Guide';
import { ManualPage } from './pages/Manual';
import { DocsIndexPage, DocDetailPage } from './pages/Docs';
import { FaqPage } from './pages/Faq';
import { NotFoundPage } from './pages/NotFound';
import { Footer } from './sections/Footer';

/* Simple shell: theme + router + one release fetch shared by header + pages. */
function Routes() {
  const path = usePath();
  const rel = useLatestRelease();
  useRouteScroll();
  useRouteMeta();
  const docSlug = path.startsWith('/docs/') ? decodeURIComponent(path.slice('/docs/'.length).split('/')[0]) : null;
  return (
    <div id="top" style={{ backgroundColor: 'var(--bg-canvas)', color: 'var(--text-primary)', minHeight: '100vh' }}>
      <SiteHeader version={rel.tag} />
      <main key={docSlug ? `/docs/${docSlug}` : path}>
        {path === '/' ? <HomePage rel={rel} />
          : path === '/download' ? <DownloadPage rel={rel} />
          : path === '/changelog' ? <ChangelogPage />
          : path === '/guide' ? <GuidePage />
          : path === '/manual' ? <ManualPage />
          : path === '/docs' ? <DocsIndexPage />
          : docSlug ? <DocDetailPage slug={docSlug} />
          : path === '/faq' ? <FaqPage />
          : <NotFoundPage />}
      </main>
      <Footer />
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <RouterProvider>
        <Routes />
      </RouterProvider>
    </ThemeProvider>
  );
}
