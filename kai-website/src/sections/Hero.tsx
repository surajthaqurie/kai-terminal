import { ArrowRight, Code2, Download, ShieldCheck, Sparkles } from 'lucide-react';
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
          <Badge><Sparkles size={14} /> {tag} · Free MIT · Tauri 2 + Rust</Badge>
        </div>

        <h1 className="t-hero-title t-enter" style={{ animationDelay: '70ms' }}>
          <span className="t-hero-title-line">One terminal.</span>
          <span className="t-hero-title-line">Every platform.</span>
        </h1>

        <p className="t-hero-sub t-enter" style={{ animationDelay: '140ms' }}>
          A fast, keyboard-first terminal with a native Rust engine and built-in Project Intelligence — local code context for your AI coding assistant. Free, private, zero telemetry.
        </p>

        <p className="t-hero-reassure t-enter" style={{ animationDelay: '190ms' }}>
          <ShieldCheck size={15} />
          <span>New here? Install in 30 seconds — no account, no config wizard. Works with Claude, Cursor, Codex, Gemini &amp; more.</span>
        </p>

        <div className="t-enter" style={{ animationDelay: '230ms' }}>
          <InstallBar short={short} />
        </div>

        <div className="t-hero-cta t-enter" style={{ animationDelay: '300ms' }}>
          <Button href={activeDl.url}>
            <Download size={18} /> {activeDl.label} <span className="t-btn-sub">{activeDl.sub}</span>
          </Button>
          <Button href="/download" variant="secondary">
            All Installers <ArrowRight size={16} />
          </Button>
          <Button href={REPO_URL} variant="secondary" target="_blank" rel="noreferrer">
            <Code2 size={18} /> GitHub
          </Button>
        </div>

        <p className="t-hero-os-hint t-enter" style={{ animationDelay: '330ms' }}>
          We picked “{activeDl.label}” for you — wrong OS? Choose below or on the download page.
        </p>

        <div className="t-quick-dl t-enter" style={{ animationDelay: '360ms' }}>
          <span className="t-quick-dl-label">Direct downloads:</span>
          <a href={directUrls.macos.url} className="t-quick-dl-pill"><Download size={12} /> macOS .dmg</a>
          <a href={directUrls.linux.url} className="t-quick-dl-pill"><Download size={12} /> Linux .deb</a>
          <a href={rel?.asset((n) => n.toLowerCase().includes('amd64') && n.toLowerCase().endsWith('.appimage'), `kai_${short}_amd64.AppImage`) ?? `${REPO_URL}/releases/download/${tag}/kai_${short}_amd64.AppImage`} className="t-quick-dl-pill">Linux .AppImage</a>
          <a href={directUrls.windows.url} className="t-quick-dl-pill"><Download size={12} /> Windows .exe</a>
          <a href={rel?.asset((n) => n.toLowerCase().endsWith('.msi'), `Kai_${short}_x64_en-US.msi`) ?? `${REPO_URL}/releases/download/${tag}/Kai_${short}_x64_en-US.msi`} className="t-quick-dl-pill">Windows .msi</a>
        </div>

        <div className="t-stats t-enter" style={{ animationDelay: '400ms' }}>
          {STATS.map(([v, l]) => (
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
