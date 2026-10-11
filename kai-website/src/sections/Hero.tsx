import { ArrowRight, Code2, Download, Sparkles } from 'lucide-react';
import { Badge, Button } from '../components/ui';
import { InstallBar } from '../components/InstallBar';
import { HeroTerminal } from '../components/HeroTerminal';
import { REPO_URL } from '../data/site';

const STATS: Array<[string, string]> = [
  ['~30MB', 'idle RAM'],
  ['<10ms', 'retrieval latency'],
  ['~70%', 'token savings'],
  ['0', 'telemetry · leaks'],
];

export function Hero({ tag, short, version }: { tag: string; short: string; version: string }) {
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
          A GPU-rendered terminal with a native Rust PTY and built-in Project Intelligence. Serve AST symbol context to Claude Code, Cursor, and Codex over MCP — zero cloud hops, zero telemetry.
        </p>

        <div className="t-enter" style={{ animationDelay: '260ms' }}>
          <InstallBar short={short} />
        </div>

        <div className="t-hero-cta t-enter" style={{ animationDelay: '340ms' }}>
          <Button href="/download"><Download size={18} /> Download <ArrowRight size={16} /></Button>
          <Button href={REPO_URL} variant="secondary" target="_blank" rel="noreferrer"><Code2 size={18} /> git clone</Button>
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
