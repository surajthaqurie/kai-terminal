import { useEffect } from 'react';
import { ThemeProvider } from './theme/ThemeContext';
import { useLatestRelease } from './hooks/useRepo';
import { RouterProvider, usePath, useRouteMeta, useRouteScroll } from './router';
import { SiteHeader } from './components/Header';
import { HomePage } from './pages/Home';
import { DownloadPage } from './pages/Download';
import { ChangelogPage } from './pages/Changelog';
import { GuidePage } from './pages/Guide';
import { FaqPage } from './pages/Faq';
import { NotFoundPage } from './pages/NotFound';
import { Footer } from './sections/Footer';

function Routes() {
  const path = usePath();
  const rel = useLatestRelease();
  useRouteScroll();
  useRouteMeta();

  let page: React.ReactNode;
  switch (path) {
    case '/':
      page = <HomePage rel={rel} />;
      break;
    case '/download':
      page = <DownloadPage rel={rel} />;
      break;
    case '/changelog':
      page = <ChangelogPage />;
      break;
    case '/guide':
      page = <GuidePage />;
      break;
    case '/faq':
      page = <FaqPage />;
      break;
    default:
      page = <NotFoundPage />;
  }

  return (
    <div id="top" style={{ backgroundColor: 'var(--bg-canvas)', color: 'var(--text-primary)', minHeight: '100vh', transition: 'background-color .25s ease, color .25s ease' }}>
      <SiteHeader version={rel.tag} />
      <main key={path}>{page}</main>
      <Footer />
    </div>
  );
}

function SiteContent() {
  /* IO sentinel probe: only gate hidden reveal states behind .io-ok once a
     live IntersectionObserver callback is observed. If IO is missing or
     never fires in this environment, content simply stays visible. */
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;pointer-events:none;';
    document.body.appendChild(probe);
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        document.documentElement.classList.add('io-ok');
        io.disconnect();
        probe.remove();
      }
    });
    io.observe(probe);
    const t = setTimeout(() => {
      io.disconnect();
      probe.remove();
    }, 1200);
    return () => {
      clearTimeout(t);
      io.disconnect();
      probe.remove();
    };
  }, []);

  /* Scroll-rect fallback for reveals: IntersectionObserver is primary
     (see Reveal in ui.tsx), but if it never fires in some environment,
     anything actually in the viewport still gets shown on scroll/resize
     *and* on delayed retries after mount (late fonts/layout can shift
     rects after the first check). The listener persists across route
     changes; per-page elements self-reveal via useReveal on mount. */
  useEffect(() => {
    const showVisible = () => {
      document.querySelectorAll('.t-reveal:not(.is-visible)').forEach((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.top < window.innerHeight - 48 && r.bottom > 0) el.classList.add('is-visible');
      });
    };
    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        showVisible();
        queued = false;
      });
    };
    showVisible();
    const t1 = setTimeout(showVisible, 300);
    const t2 = setTimeout(showVisible, 1200);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return <Routes />;
}

export default function App() {
  return (
    <ThemeProvider>
      <RouterProvider>
        <SiteContent />
      </RouterProvider>
    </ThemeProvider>
  );
}
