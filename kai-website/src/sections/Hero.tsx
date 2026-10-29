'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, Code2, Download } from 'lucide-react';
import { Badge, Button } from '../components/ui';
import { HeroTerminal } from '../components/HeroTerminal';
import { REPO_URL } from '../data/site';
import { detectOs, OS_LABEL, type OsId } from '../lib/os';
import { Link } from '../router';
import type { SerializableRelease } from '../lib/release';
import { assetUrl } from '../lib/release';
import { useResolvedRelease } from '../hooks/useRepo';

export function Hero({ tag: serverTag, short: serverShort, version, rel: serverRel }: { tag: string; short: string; version: string; rel?: SerializableRelease }) {
  // Links must point at a release GitHub really serves, not the version
  // committed in release.json (see useResolvedRelease).
  const rel = useResolvedRelease(serverRel ?? { tag: serverTag, short: serverShort, assets: [] });
  const { tag, short } = rel;
  // SSR-safe default ('linux') so server HTML and first client render agree;
  // the visitor's real OS is adopted after mount with no hydration mismatch.
  const [os, setOs] = useState<OsId>('linux');
  useEffect(() => { setOs(detectOs()); }, []);
  const osName = OS_LABEL[os] ?? 'Linux';

  const macDmg =
    rel ? assetUrl(rel, (n) => n.toLowerCase().endsWith('.dmg'), `kai_${short}_aarch64.dmg`) :
    `${REPO_URL}/releases/download/${tag}/kai_${short}_aarch64.dmg`;
  const linuxDeb =
    rel ? assetUrl(rel, (n) => n.toLowerCase().includes('amd64') && n.toLowerCase().endsWith('.deb'), `kai_${short}_amd64.deb`) :
    `${REPO_URL}/releases/download/${tag}/kai_${short}_amd64.deb`;
  const linuxApp =
    rel ? assetUrl(rel, (n) => n.toLowerCase().includes('amd64') && n.toLowerCase().endsWith('.appimage'), `kai_${short}_amd64.AppImage`) :
    `${REPO_URL}/releases/download/${tag}/kai_${short}_amd64.AppImage`;
  const winExe =
    rel ? assetUrl(rel, (n) => n.toLowerCase().endsWith('setup.exe'), `kai_${short}_x64-setup.exe`) :
    `${REPO_URL}/releases/download/${tag}/kai_${short}_x64-setup.exe`;
  const winMsi =
    rel ? assetUrl(rel, (n) => n.toLowerCase().endsWith('.msi'), `kai_${short}_x64_en-US.msi`) :
    `${REPO_URL}/releases/download/${tag}/kai_${short}_x64_en-US.msi`;

  const primaryFormat = os === 'macos' ? '.dmg' : os === 'windows' ? '.exe' : '.deb';

  const primaryDownload =
    os === 'macos'
      ? { url: macDmg, label: '.dmg (Apple Silicon)', name: `kai_${short}_aarch64.dmg` }
      : os === 'windows'
      ? { url: winExe, label: '.exe installer', name: `kai_${short}_x64-setup.exe` }
      : { url: linuxDeb, label: '.deb (x64)', name: `kai_${short}_amd64.deb` };

  const secondaryDownload =
    os === 'linux'
      ? { url: linuxApp, label: '.AppImage', name: `kai_${short}_amd64.AppImage` }
      : os === 'windows'
      ? { url: winMsi, label: '.msi package', name: `kai_${short}_x64_en-US.msi` }
      : null;

  return (
    <section className="t-hero">
      <div className="t-hero-inner">
        <div className="t-enter" style={{ animationDelay: '0ms' }}>
          <Badge>{tag} · MIT · Tauri 2 + Rust</Badge>
        </div>

        <h1 className="t-hero-title t-enter" style={{ animationDelay: '70ms' }}>
          <span className="t-hero-title-line">One terminal.</span>
          <span className="t-hero-title-line">Every platform.</span>
        </h1>

        <p className="t-hero-sub t-enter" style={{ animationDelay: '140ms' }}>
          Kai is a terminal for macOS, Linux, and Windows, with tabs, split
          panes, and a built-in way to run AI coding tools on your own code.
          Free and MIT licensed — no account, no tracking.
        </p>

        {/* Interactive preview terminal on top */}
        <p className="t-hint t-enter t-terminal-hint" style={{ animationDelay: '200ms' }}>
          <span>Try it — click a chip or type</span> <code>help</code> <span>and press Enter.</span>
        </p>

        <div className="t-enter" style={{ animationDelay: '260ms' }}>
          <HeroTerminal version={version} />
        </div>

        {/* Download section: clean balanced buttons */}
        <div className="t-hero-cta t-enter" style={{ animationDelay: '320ms' }}>
          <Button
            href={primaryDownload.url}
            className="t-btn--hero-primary"
            target="_blank"
            rel="noopener noreferrer"
            title={`Download Kai for ${osName} (${primaryDownload.name})`}
          >
            <Download size={18} />
            <span>Download Kai for {osName}</span>
            <span className="t-btn-pill">{primaryFormat}</span>
          </Button>
          <Button href={REPO_URL} variant="secondary" target="_blank" rel="noreferrer">
            <Code2 size={18} /> GitHub
          </Button>
          <Button href="/guide" variant="secondary">
            Setup guide <ArrowRight size={16} />
          </Button>
        </div>

        {/* Direct downloads quick chips for the detected OS */}
        <div className="t-hero-dl-row t-enter" style={{ animationDelay: '360ms' }}>
          <span className="t-hero-dl-label">Direct downloads:</span>
          <a
            href={primaryDownload.url}
            className="t-dl-chip t-dl-chip--active"
            target="_blank"
            rel="noopener noreferrer"
            title={`Download ${primaryDownload.name}`}
          >
            <Download size={13} /> {primaryDownload.label}
          </a>
          {secondaryDownload && (
            <a
              href={secondaryDownload.url}
              className="t-dl-chip"
              target="_blank"
              rel="noopener noreferrer"
              title={`Download ${secondaryDownload.name}`}
            >
              <Download size={13} /> {secondaryDownload.label}
            </a>
          )}
          <span className="t-dl-sep">·</span>
          <Link to="/download" className="t-dl-link">
            All platforms (macOS, Linux, Windows) →
          </Link>
        </div>

        {rel && rel.assets.length === 0 && (
          <p className="t-hero-reassure t-enter" style={{ animationDelay: '400ms' }}>
            <span>Installers for {tag} aren't published yet — the download page shows how to build from source.</span>
          </p>
        )}
      </div>
    </section>
  );
}
