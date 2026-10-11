import { ArrowRight, Code2, Download, Sparkles } from 'lucide-react';
import { Badge, Button } from '../components/ui';
import { InstallBar } from '../components/InstallBar';
import { HeroTerminal } from '../components/HeroTerminal';
import { REPO_URL } from '../data/site';
import type { LatestRelease } from '../hooks/useRepo';

const STATS: Array<[string, string]> = [
  ['~30MB', 'idle RAM'],
  ['<10ms', 'retrieval latency'],
  ['~70%', 'token savings'],
  ['0', 'telemetry · leaks'],
];

function detectOs(): 'windows' | 'linux' | 'macos' {
  if (typeof navigator === 'undefined') return 'linux';
  const p = (navigator.platform ?? '').toLowerCase();
  const ua = navigator.userAgent.toLowerCase();
  if (p.includes('mac') || ua.includes('mac')) return 'macos';
  if (p.includes('win') || ua.includes('windows')) return 'windows';
  return 'linux';
}

export function Hero({ tag, short, version, rel }: { tag: string; short: string; version: string; rel?: LatestRelease }) {
  const userOs = detectOs();
  const directUrls = {
    windows: {
      url: rel?.asset((n) => n.toLowerCase().endsWith('setup.exe'), `Kai_${short}_x64-setup.exe`) ?? `${REPO_URL}/releases/download/${tag}/Kai_${short}_x64-setup.exe`,
      label: 'Download for Windows',
      sub: '.exe setup (x64)',
    },
    linux: {
      url: rel?.asset((n) => n.toLowerCase().includes('amd64') && n.toLowerCase().endsWith('.deb'), `kai_${short}_amd64.deb`) ?? `${REPO_URL}/releases/download/${tag}/kai_${short}_amd64.deb`,
      label: 'Download for Linux',
      sub: '.deb (x64)',
    },
    macos: {
      url: rel?.asset((n) => n.toLowerCase().endsWith('.dmg'), `Kai_${short}_aarch64.dmg`) ?? `${REPO_URL}/releases/download/${tag}/Kai_${short}_aarch64.dmg`,
      label: 'Download for macOS',
      sub: '.dmg (Apple Silicon)',
    },
  };
  const activeDl = directUrls[userOs];

  return (
    <section className="t-hero">
      <div className="t-hero-glow"></div>
      <div className="t-hero-inner">
        <div className="t-enter" style={{ animationDelay: '0ms' }}>
          <Badge><Sparkles size={14} /> {tag} · MIT · Tauri 2 + Rust + MCP</Badge>
        </div>

        <h1 className="t-hero-title t-enter" style={{ animationDelay: '90ms' }}>
          One terminal.<br />Every platform.
        </h1>

        <p className="t-hero-sub t-enter" style={{ animationDelay: '180ms' }}>
          A GPU-rendered terminal with a native Rust PTY and built-in Project Intelligence. Serve AST symbol context to Claude Code, Cursor, Codex, Gemini, Copilot, Windsurf &amp; Cline over MCP — zero cloud hops, zero telemetry.
        </p>

        <div className="t-enter" style={{ animationDelay: '260ms' }}>
          <InstallBar short={short} />
        </div>

        <div className="t-hero-cta t-enter" style={{ animationDelay: '340ms' }}>
          <Button href={activeDl.url}>
            <Download size={18} /> {activeDl.label} <span style={{ opacity: 0.85, fontSize: '0.85em', fontWeight: 400 }}>{activeDl.sub}</span>
          </Button>
          <Button href="/download" variant="secondary">
            All Installers <ArrowRight size={16} />
          </Button>
          <Button href={REPO_URL} variant="secondary" target="_blank" rel="noreferrer">
            <Code2 size={18} /> GitHub
          </Button>
        </div>

        <div className="t-quick-dl t-enter" style={{ animationDelay: '380ms' }}>
          <span className="t-quick-dl-label">Direct downloads:</span>
          <a href={directUrls.windows.url} className="t-quick-dl-pill"><Download size={12} /> Windows .exe</a>
          <a href={rel?.asset((n) => n.toLowerCase().endsWith('.msi'), `Kai_${short}_x64_en-US.msi`) ?? `${REPO_URL}/releases/download/${tag}/Kai_${short}_x64_en-US.msi`} className="t-quick-dl-pill">Windows .msi</a>
          <a href={directUrls.linux.url} className="t-quick-dl-pill"><Download size={12} /> Linux .deb</a>
          <a href={rel?.asset((n) => n.toLowerCase().includes('amd64') && n.toLowerCase().endsWith('.appimage'), `kai_${short}_amd64.AppImage`) ?? `${REPO_URL}/releases/download/${tag}/kai_${short}_amd64.AppImage`} className="t-quick-dl-pill">Linux .AppImage</a>
          <a href={directUrls.macos.url} className="t-quick-dl-pill"><Download size={12} /> macOS .dmg</a>
        </div>

        <div className="t-stats t-enter" style={{ animationDelay: '420ms' }}>
          {STATS.map(([v, l]) => (
            <div key={l} className="t-stat"><b>{v}</b><span>{l}</span></div>
          ))}
        </div>

        <div className="t-enter" style={{ animationDelay: '500ms' }}>
          <HeroTerminal version={version} />
        </div>
        <p className="t-hint t-enter" style={{ animationDelay: '600ms' }}>Interactive preview — click a chip or type <code>help</code>.</p>
      </div>
    </section>
  );
}
