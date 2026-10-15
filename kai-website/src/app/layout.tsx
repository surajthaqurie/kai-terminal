import type { Metadata, Viewport } from 'next';
import { ThemeProvider } from '../theme/ThemeContext';
import { SiteHeader } from '../components/Header';
import { Footer } from '../sections/Footer';
import { ScrollManager } from './scroll-manager';
import { SITE_URL } from '../data/site';
import { getServerRelease } from '../lib/release';
import { jsonLdSoftware, jsonLdWebsite } from '../lib/seo';
import '../index.css';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Kai — Fast, GPU-Accelerated Terminal for AI Coding Agents',
    template: '%s',
  },
  description:
    'Hardware-accelerated terminal for macOS, Linux, and Windows with a native local project intelligence engine for AI agents.',
  alternates: { canonical: SITE_URL + '/' },
  openGraph: {
    title: 'Kai — Terminal for macOS, Linux, Windows',
    description: 'Desktop terminal + local CLI for AI context. MIT. macOS .dmg, Linux .deb/.AppImage, Windows .exe/.msi.',
    url: SITE_URL + '/',
    siteName: 'Kai',
    type: 'website',
    images: [{ url: `${SITE_URL}/og.png`, width: 1200, height: 630, alt: 'Kai terminal' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Kai — Terminal for macOS, Linux, Windows',
    description: 'Tauri + Rust terminal. MIT. Installers for macOS, Linux, Windows.',
    images: [`${SITE_URL}/og.png`],
  },
  icons: {
    icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }, { url: '/favicon.png', type: 'image/png' }],
    apple: '/icon.png',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#111318' },
    { media: '(prefers-color-scheme: light)', color: '#f8fafc' },
  ],
};

const THEME_INIT = `(function(){try{var t=localStorage.getItem('kai-theme');if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t;}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const rel = getServerRelease();
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        <script dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.add('js')" }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLdWebsite()) }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLdSoftware()) }} />
      </head>
      <body>
        <ThemeProvider>
          <ScrollManager />
          <div id="top" style={{ backgroundColor: 'var(--bg-canvas)', color: 'var(--text-primary)', minHeight: '100vh' }}>
            <SiteHeader version={rel.tag} />
            <main>{children}</main>
            <Footer />
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
