import { ArrowRight, Code2, Download } from 'lucide-react';
import { Badge, Button } from '../components/ui';
import { InstallBar } from '../components/InstallBar';
import { HeroTerminal } from '../components/HeroTerminal';
import { REPO_URL } from '../data/site';
import type { LatestRelease } from '../hooks/useRepo';

export function Hero({ tag, short, version, rel }: { tag: string; short: string; version: string; rel?: LatestRelease }) {

  return (
    <section className="t-hero">
      <div className="t-hero-glow"></div>
      <div className="t-hero-inner">
        <div className="t-enter" style={{ animationDelay: '0ms' }}>
          <Badge>{tag} · MIT · Tauri 2 + Rust</Badge>
        </div>

        <h1 className="t-hero-title t-enter" style={{ animationDelay: '70ms' }}>
          <span className="t-hero-title-line">One terminal.</span>
          <span className="t-hero-title-line">Every platform.</span>
        </h1>

        <p className="t-hero-sub t-enter" style={{ animationDelay: '140ms' }}>
          Kai is a fast, GPU-accelerated desktop terminal with an embedded local project intelligence engine for AI coding agents. Native PTY, WebGL 60fps rendering, and zero-remount split panes on macOS, Linux, and Windows.
        </p>

        <p className="t-hero-reassure t-enter" style={{ animationDelay: '190ms' }}>
          <span>Free and open source under the MIT license. Zero telemetry, zero accounts.</span>
        </p>

        <div className="t-enter" style={{ animationDelay: '230ms' }}>
          <InstallBar short={short} />
        </div>

        <div className="t-hero-cta t-enter" style={{ animationDelay: '300ms' }}>
          <Button href="/download">
            <Download size={18} /> Download Kai
          </Button>
          <Button href={REPO_URL} variant="secondary" target="_blank" rel="noreferrer">
            <Code2 size={18} /> GitHub
          </Button>
          <Button href="/guide" variant="secondary">
            Setup guide <ArrowRight size={16} />
          </Button>
        </div>

        <div className="t-quick-dl t-enter" style={{ animationDelay: '360ms' }}>
          {rel && rel.assets.length === 0 ? (
            <span className="t-quick-dl-label" style={{ lineHeight: 1.6 }}>
              Installers for {tag} aren't published on GitHub yet — see the download page for source build, or watch Releases.
            </span>
          ) : (
            <>
              <span className="t-quick-dl-label">All files ({tag}):</span>
              <a href={macUrl} className="t-quick-dl-pill"><Download size={12} /> macOS .dmg</a>
              <a href={linuxDeb} className="t-quick-dl-pill"><Download size={12} /> Linux .deb</a>
              <a href={linuxApp} className="t-quick-dl-pill"><Download size={12} /> Linux .AppImage</a>
              <a href={winExe} className="t-quick-dl-pill"><Download size={12} /> Windows .exe</a>
              <a href={winMsi} className="t-quick-dl-pill"><Download size={12} /> Windows .msi</a>
            </>
          )}
        </div>

        <div className="t-stats t-enter" style={{ animationDelay: '400ms' }}>
          {stats.map(([v, l]) => (
            <div key={l} className="t-stat"><b>{v}</b><span>{l}</span></div>
          ))}
        </div>

        <div className="t-enter" style={{ animationDelay: '460ms' }}>
          <HeroTerminal version={version} />
        </div>
        <p className="t-hint t-enter t-terminal-hint" style={{ animationDelay: '520ms' }}><span>Interactive preview — click a chip or type</span> <code>help</code> <span>and press Enter.</span></p>
      </div>
    </section>
  );
}
