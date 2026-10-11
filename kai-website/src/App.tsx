import React, { useEffect, useRef, useState } from 'react';
import {
  Terminal,
  Cpu,
  ShieldCheck,
  Zap,
  Download,
  Github,
  CheckCircle2,
  Sparkles,
  Layers,
  Monitor,
  Bot,
  Code2,
  ExternalLink,
  PackageCheck,
  HelpCircle,
  ArrowRight,
  Sun,
  Moon,
  Menu,
  X,
  Copy,
  Check,
  ChevronRight,
} from 'lucide-react';
import { ThemeProvider, useTheme } from './theme/ThemeContext';
import { Badge, Button, Card, Section, SectionHead } from './components/ui';

const REPO_URL = 'https://github.com/surajthaqurie/kai-terminal';
const LATEST_RELEASE_URL = `${REPO_URL}/releases/latest`;
const FALLBACK_TAG = 'v0.1.0';

type ReleaseAsset = { name: string; url: string };

function useLatestRelease() {
  const [rel, setRel] = useState<{ tag: string; assets: ReleaseAsset[] } | null>(() => {
    const cached = readCache('kai-release');
    if (!cached) return null;
    try {
      const parsed = JSON.parse(cached) as { tag: string; assets: ReleaseAsset[] };
      if (typeof parsed.tag === 'string' && Array.isArray(parsed.assets)) return parsed;
    } catch {
      /* corrupt cache — refetch below */
    }
    return null;
  });
  useEffect(() => {
    let live = true;
    fetch('https://api.github.com/repos/surajthaqurie/kai-terminal/releases/latest')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!live || !j || typeof j.tag_name !== 'string') return;
        const assets: ReleaseAsset[] = Array.isArray(j.assets)
          ? j.assets
            .filter((a: any) => a && typeof a.name === 'string' && typeof a.browser_download_url === 'string')
            .map((a: any) => ({ name: a.name as string, url: a.browser_download_url as string }))
          : [];
        const next = { tag: j.tag_name as string, assets };
        setRel(next);
        writeCache('kai-release', JSON.stringify(next));
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  const tag = rel?.tag ?? FALLBACK_TAG;
  const short = tag.replace(/^v/, '');
  const asset = (match: (name: string) => boolean, fallbackFile: string) => {
    const hit = rel?.assets.find((a) => match(a.name));
    if (hit) return hit.url;
    return `${LATEST_RELEASE_URL}/download/${fallbackFile.replace('0.1.0', short)}`;
  };
  return { tag, short, asset };
}

/* ---------- small helpers ---------- */

function useCopy(text: string) {
  const [ok, setOk] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setOk(true);
    setTimeout(() => setOk(false), 1400);
  };
  return { ok, copy };
}

function CopyBtn({ text }: { text: string }) {
  const { ok, copy } = useCopy(text);
  return (
    <button type="button" className="t-copy" onClick={copy} aria-label="Copy to clipboard" title="Copy">
      {ok ? <Check size={15} /> : <Copy size={15} />}
    </button>
  );
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      className="t-theme-toggle"
      onClick={toggle}
      aria-pressed={dark}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}

/* ---------- cached fetch helpers (1h localStorage TTL, silent offline fallback) ---------- */

const CACHE_TTL = 3_600_000;

function readCache(key: string): string | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { t: number; v: string };
    if (typeof parsed.t !== 'number' || Date.now() - parsed.t > CACHE_TTL) return null;
    return typeof parsed.v === 'string' ? parsed.v : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, v: string) {
  try {
    localStorage.setItem(key, JSON.stringify({ t: Date.now(), v }));
  } catch {
    /* storage full or blocked — non-fatal */
  }
}

function useRepoStars() {
  const [stars, setStars] = useState<string | null>(() => readCache('kai-stars'));
  useEffect(() => {
    let live = true;
    fetch('https://api.github.com/repos/surajthaqurie/kai-terminal')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!live || !j || typeof j.stargazers_count !== 'number') return;
        const n: number = j.stargazers_count;
        const label = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
        setStars(label);
        writeCache('kai-stars', label);
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return stars;
}

function SiteHeader({ version }: { version: string }) {
  const [open, setOpen] = useState(false);
  const stars = useRepoStars();
  return (
    <header className="t-header">
      <div className="t-header-inner" style={{ position: 'relative' }}>
        <a className="t-brand" href="#top" aria-label="Kai home">
          <div className="t-brand-mark">
            <Terminal size={22} color="#ffffff" />
          </div>
          <div>
            <span className="t-brand-name">kai</span>
            <span className="t-version">{version}</span>
          </div>
        </a>

        <nav className="t-nav" data-open={open} aria-label="Primary">
          <a href="#quickstart" onClick={() => setOpen(false)}>Quickstart</a>
          <a href="#features" onClick={() => setOpen(false)}>Features</a>
          <a href="#ai-cli" onClick={() => setOpen(false)}>AI</a>
          <a href="#compare" onClick={() => setOpen(false)}>Compare</a>
          <a href="#downloads" onClick={() => setOpen(false)}>Download</a>
          <a href="#faq" onClick={() => setOpen(false)}>FAQ</a>
        </nav>

        <div className="t-header-actions">
          <ThemeToggle />
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="t-btn t-btn--secondary t-btn--sm t-star">
            <Github size={16} /> <span className="t-header-cta-label">Star</span>
            {stars ? <span className="t-star-n">{stars}</span> : null}
          </a>
          <a href="#downloads" className="t-btn t-btn--primary t-btn--sm">
            <Download size={16} /> <span className="t-header-cta-label">Get Kai</span>
          </a>
          <button
            type="button"
            className="t-theme-toggle t-menu-btn"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? 'Close menu' : 'Open menu'}
          >
            {open ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </div>
    </header>
  );
}

/* ---------- install commands (developer-first) ---------- */

const INSTALL_TABS = [
  {
    id: 'windows',
    label: 'Windows',
    lang: 'powershell',
    cmd: 'winget install Kai-terminal --source github',
    file: 'Kai_0.1.0_x64-setup.exe',
    note: 'or grab .exe / .msi from Releases',
  },
  {
    id: 'linux',
    label: 'Linux',
    lang: 'bash',
    cmd: 'sudo dpkg -i kai_0.1.0_amd64.deb  # or chmod +x kai_*.AppImage',
    file: 'kai_0.1.0_amd64.deb',
    note: '.deb x64/ARM64 · .AppImage x64/ARM64',
  },
  {
    id: 'macos',
    label: 'macOS',
    lang: 'bash',
    cmd: 'open Kai_0.1.0_aarch64.dmg  # drag to /Applications',
    file: 'Kai_0.1.0_aarch64.dmg',
    note: 'Apple Silicon M1–M4 · macOS 12+',
  },
  {
    id: 'source',
    label: 'From source',
    lang: 'bash',
    cmd: 'git clone https://github.com/surajthaqurie/kai-terminal.git && cd kai-terminal && cargo run --release',
    file: 'MIT · Rust + Tauri 2',
    note: 'needs Rust + Node 20+',
  },
] as const;

function InstallBar({ short }: { short: string }) {
  const [tab, setTab] = useState<string>(() => {
    if (typeof navigator === 'undefined') return 'linux';
    const p = navigator.platform.toLowerCase();
    const ua = navigator.userAgent.toLowerCase();
    if (p.includes('mac') || ua.includes('mac')) return 'macos';
    if (p.includes('win') || ua.includes('windows')) return 'windows';
    return 'linux';
  });
  const active0 = INSTALL_TABS.find((t) => t.id === tab)!;
  const active = { ...active0, cmd: active0.cmd.replace(/0\.1\.0/g, short) };
  return (
    <div className="t-install" role="region" aria-label="Install Kai">
      <div className="t-install-tabs" role="tablist">
        {INSTALL_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className="t-install-tab"
            data-active={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="t-install-body">
        <span className="t-install-prompt">$</span>
        <code className="t-install-cmd">{active.cmd}</code>
        <CopyBtn text={active.cmd} />
      </div>
      <div className="t-install-note">{active.note}</div>
    </div>
  );
}

/* ---------- hero terminal (click chip = run) ---------- */

function HeroTerminal({ version }: { version: string }) {
  const [terminalInput, setTerminalInput] = useState('');
  const viewRef = useRef<HTMLDivElement | null>(null);
  const [terminalHistory, setTerminalHistory] = useState<
    Array<{ cmd: string; output: React.ReactNode }>
  >([
    {
      cmd: 'kai --status',
      output: (
        <div style={{ color: '#34d399' }}>
          <p>✔ engine {version} · portable-pty 0.8 · xterm.js 60fps</p>
          <p>✔ tabs isolated · zero telemetry · MIT</p>
        </div>
      ),
    },
  ]);

  const run = (rawInput: string) => {
    const input = rawInput.trim().toLowerCase();
    if (!input) return;
    let reply: React.ReactNode = '';
    if (['help', '?', 'kai --help', 'kai -h'].includes(input)) {
      reply = (
        <div style={{ color: '#67e8f9' }}>
          <p>try: <b style={{ color: '#fcd34d' }}>status</b> · <b style={{ color: '#fcd34d' }}>ai</b> · <b style={{ color: '#fcd34d' }}>claude</b> · <b style={{ color: '#fcd34d' }}>downloads</b> · <b style={{ color: '#fcd34d' }}>clear</b></p>
        </div>
      );
    } else if (['status', 'kai --status', 'kai status'].includes(input)) {
      reply = (
        <div style={{ color: '#34d399' }}>
          <p>✔ engine operational · ConPTY / POSIX pty</p>
          <p>✔ render: xterm.js canvas @ 60fps</p>
          <p>✔ 3 AI CLIs on PATH · no bundled binaries</p>
        </div>
      );
    } else if (['claude', 'codex', 'gemini', 'ai'].includes(input) || input.startsWith('kai ')) {
      reply = (
        <div style={{ color: '#d8b4fe' }}>
          <p>codex <span style={{ color: '#34d399' }}>✓</span> /usr/local/bin/codex · claude <span style={{ color: '#34d399' }}>✓</span> /usr/bin/claude · gemini <span style={{ color: '#34d399' }}>✓</span> ~/bin/gemini</p>
          <p style={{ color: '#94a3b8', fontSize: '0.75rem' }}>kai never bundles AI binaries — you own keys + execution.</p>
        </div>
      );
    } else if (['downloads', 'download', 'install'].includes(input)) {
      reply = (
        <div style={{ color: '#67e8f9' }}>
          <p>.exe/.msi · .deb/.AppImage · .dmg (M1-M4)</p>
          <p style={{ color: '#94a3b8' }}>$ scroll to #downloads or run tab above ↑</p>
        </div>
      );
    } else if (['version', 'kai --version'].includes(input)) {
      reply = <p style={{ color: '#67e8f9' }}>kai {version} — Tauri 2.1 + Rust · MIT</p>;
    } else if (['ls', 'dir'].includes(input)) {
      reply = <p style={{ color: '#94a3b8' }}>src/ src-tauri/ packaging/ Cargo.toml package.json</p>;
    } else if (input === 'clear' || input === 'cls') {
      setTerminalHistory([]);
      setTerminalInput('');
      return;
    } else {
      reply = <p style={{ color: '#fb7185' }}>not found: '{rawInput}'. type 'help'.</p>;
    }
    setTerminalHistory((prev) => [...prev, { cmd: rawInput, output: reply }]);
    setTerminalInput('');
  };

  useEffect(() => {
    const el = viewRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [terminalHistory]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    run(terminalInput);
  };

  const chips = ['kai --status', 'ai', 'downloads', 'help'];

  return (
    <div className="t-terminal" role="region" aria-label="Interactive Kai demo terminal">
      <div className="t-terminal-bar">
        <div className="t-terminal-dots">
          <span className="t-dot" style={{ backgroundColor: '#ef4444' }}></span>
          <span className="t-dot" style={{ backgroundColor: '#f59e0b' }}></span>
          <span className="t-dot" style={{ backgroundColor: '#10b981' }}></span>
          <span className="t-terminal-title">kai — zsh</span>
        </div>
        <div className="t-terminal-chips">
          {chips.map((c) => (
            <button key={c} type="button" onClick={() => run(c)} className="t-chip">
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="t-terminal-view" ref={viewRef}>
        {terminalHistory.map((item, idx) => (
          <div key={idx} className="t-term-line">
            <div className="t-term-prompt">
              <span>➜ ~</span>
              <span className="t-term-cmd">{item.cmd}</span>
            </div>
            <div className="t-term-out">{item.output}</div>
          </div>
        ))}
        <form onSubmit={onSubmit} className="t-term-form">
          <span style={{ color: '#38bdf8' }}>➜ ~</span>
          <input
            type="text"
            value={terminalInput}
            onChange={(e) => setTerminalInput(e.target.value)}
            placeholder="type 'help' + enter — it's live"
            className="t-term-input"
            aria-label="Demo terminal input"
          />
        </form>
      </div>
    </div>
  );
}

const FEATURES = [
  { icon: Cpu, tone: 't-icon--neutral', tag: 'rust · portable-pty', title: 'Native PTY core', body: 'Direct OS pty streams. No Node backend, no Electron. ConPTY on Windows, POSIX elsewhere.' },
  { icon: Zap, tone: 't-icon--neutral', tag: 'xterm.js · 60fps', title: 'GPU rendering', body: 'Canvas viewport, fast select + search, grid fit. Stays smooth on huge output.' },
  { icon: Layers, tone: 't-icon--neutral', tag: 'tabs · isolation', title: 'Isolated tabs', body: 'Per-tab cwd + process tree + pty channel. One tab dies, the rest live.' },
  { icon: Bot, tone: 't-icon--neutral', tag: 'codex · claude · gemini', title: 'Local AI CLIs', body: 'Detects tools already on your PATH. Zero bundled binaries, zero lock-in.' },
  { icon: ShieldCheck, tone: 't-icon--neutral', tag: 'zero telemetry', title: 'Private by default', body: 'No tracking, no keystroke logging, strict CSP. Everything stays local.' },
  { icon: Monitor, tone: 't-icon--neutral', tag: '~30MB idle', title: 'Tauri 2, not Electron', body: '10× lighter than Electron terminals. Fast cold start, MIT licensed.' },
];

const SHORTCUTS: Array<{ label: string; keys: string[] }> = [
  { label: 'Command palette', keys: ['Ctrl', 'Shift', 'P'] },
  { label: 'New tab', keys: ['Ctrl', 'Shift', 'T'] },
  { label: 'Split horizontal', keys: ['Ctrl', 'Alt', 'S'] },
  { label: 'Split vertical', keys: ['Ctrl', 'Alt', 'V'] },
  { label: 'Find in output', keys: ['Ctrl', 'Shift', 'F'] },
  { label: 'Next / prev tab', keys: ['Ctrl', 'Shift', ']', '['] },
  { label: 'Restart session', keys: ['Ctrl', 'Shift', 'R'] },
  { label: 'Settings', keys: ['Ctrl', 'Shift', ','] },
];

const COMPARE_ROWS: Array<{ label: string; kai: string; electron: string; alacritty: string }> = [
  { label: 'Idle RAM', kai: '~30 MB', electron: '300 MB+', alacritty: 'low' },
  { label: 'Tabs + split panes', kai: 'built in', electron: 'built in', alacritty: 'via tmux' },
  { label: 'AI CLI detection', kai: 'built in', electron: 'plugins', alacritty: 'manual' },
  { label: 'Telemetry', kai: 'zero', electron: 'varies', alacritty: 'zero' },
];

function SiteContent() {
  const [activeFaq, setActiveFaq] = useState<number | null>(0);
  const [qsTab, setQsTab] = useState<'run' | 'ai' | 'config'>('run');
  const rel = useLatestRelease();

  const faqItems = [
    { q: 'Is Kai free?', a: 'Yes — MIT. Free for personal + commercial, no paywall, reproducible builds on GitHub Actions.' },
    { q: 'Any telemetry?', a: 'No. No analytics, no keystroke logging, strict CSP. Sessions never leave your machine.' },
    { q: 'How does AI work?', a: 'Kai probes PATH for codex / claude / gemini you already installed and launches them in a full pty. Bring your own keys.' },
    { q: 'Why Tauri + Rust?', a: '~30MB idle vs 300MB+ Electron. Native portable-pty streams, faster startup, lower CPU.' },
    { q: 'Which OS builds?', a: 'Windows .exe/.msi · Linux .deb (x64/ARM64) + .AppImage · macOS .dmg (Apple Silicon).' },
  ];

  const qsCode: Record<string, string> = {
    run: '# launch + verify\nkai\nkai --status        # pty + render + AI probe\nkai --help          # all flags',
    ai: '# use tools you already have\ncodex --help        # OpenAI Codex CLI\nclaude --help       # Claude Code\nGemini --help       # Gemini CLI\n# kai auto-detects all three on PATH',
    config: '# zero-config, sensible defaults\n# theme: dark/light auto · font: Fira Code\n# shell: $SHELL on unix, ConPTY on win\n# tabs keep isolated cwd + env',
  };

  return (
    <div id="top" style={{ backgroundColor: 'var(--bg-canvas)', color: 'var(--text-primary)', minHeight: '100vh', transition: 'background-color .25s ease, color .25s ease' }}>
      <SiteHeader version={rel.tag} />
      <main>

      {/* Hero */}
      <section className="t-hero">
        <div className="t-hero-glow"></div>
        <div className="t-hero-inner">
          <div className="t-enter" style={{ animationDelay: '0ms' }}>
            <Badge><Sparkles size={14} /> {rel.tag} · MIT · Tauri 2 + Rust</Badge>
          </div>

          <h1 className="t-hero-title t-enter" style={{ animationDelay: '90ms' }}>
            One terminal.<br />Every platform.
          </h1>

          <p className="t-hero-sub t-enter" style={{ animationDelay: '180ms' }}>
            A GPU-rendered terminal with a native Rust PTY on every OS. Tabs, splits, and your own AI CLIs — no account, no telemetry.
          </p>

          <div className="t-enter" style={{ animationDelay: '260ms' }}>
            <InstallBar short={rel.short} />
          </div>

          <div className="t-hero-cta t-enter" style={{ animationDelay: '340ms' }}>
            <Button href="#downloads"><Download size={18} /> Download <ArrowRight size={16} /></Button>
            <Button href={REPO_URL} variant="secondary"><Code2 size={18} /> git clone</Button>
          </div>

          <div className="t-stats t-enter" style={{ animationDelay: '420ms' }}>
            {[
              ['~30MB', 'idle RAM'],
              ['60fps', 'xterm.js'],
              ['3 OS', 'win · linux · mac'],
              ['0', 'telemetry'],
            ].map(([v, l]) => (
              <div key={l} className="t-stat"><b>{v}</b><span>{l}</span></div>
            ))}
          </div>

          <div className="t-enter" style={{ animationDelay: '500ms' }}>
            <HeroTerminal version={rel.tag} />
          </div>
          <p className="t-hint t-enter" style={{ animationDelay: '600ms' }}>Interactive preview — click a chip or type <code>help</code>.</p>
        </div>
      </section>

      {/* Quickstart */}
      <Section id="quickstart" alt>
        <SectionHead
          title="Up and running in 30s"
          sub="Install, verify, plug in your AI CLI. No account, no config wizard."
        />
        <div className="t-split">
          <div className="t-steps">
            {[
              ['01', 'Install', 'Pick your OS above or grab a file below.'],
              ['02', 'Verify', 'Run kai --status to check pty + render health.'],
              ['03', 'Plug AI', 'Install codex / claude / gemini — Kai finds them on PATH.'],
            ].map(([n, t, d]) => (
              <div key={n} className="t-step">
                <span className="t-step-n">{n}</span>
                <div><b>{t}</b><p>{d}</p></div>
              </div>
            ))}
            <a className="t-link" href={`${REPO_URL}/blob/main/DEVELOPMENT.md`}>Read DEVELOPMENT.md <ChevronRight size={15} /></a>
          </div>
          <div className="t-panel t-code-panel">
            <div className="t-install-tabs" role="tablist">
              {(['run', 'ai', 'config'] as const).map((k) => (
                <button key={k} role="tab" aria-selected={qsTab === k} data-active={qsTab === k} className="t-install-tab" onClick={() => setQsTab(k)}>
                  {k === 'run' ? '$ quickstart' : k === 'ai' ? '$ ai' : '$ config'}
                </button>
              ))}
              <span style={{ flex: 1 }} />
              <CopyBtn text={qsCode[qsTab]} />
            </div>
            <pre className="t-code"><code>{qsCode[qsTab]}</code></pre>
          </div>
        </div>
      </Section>

      {/* Features */}
      <Section id="features">
        <SectionHead
          title="Everything a terminal should do"
          sub="Native performance, full keyboard control, zero telemetry."
        />
        <div className="t-grid-3">
          {FEATURES.map((f) => (
            <Card key={f.title} hover>
              <span className="t-tag">{f.tag}</span>
              <div className={`t-icon ${f.tone}`}>
                <f.icon size={24} />
              </div>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </Card>
          ))}
        </div>
      </Section>

      {/* AI CLI */}
      <Section id="ai-cli" alt>
        <div className="t-split">
          <div>
            <Badge tone="purple"><Bot size={14} /> BYO AI · no lock-in</Badge>
            <h2 className="t-section-title" style={{ textAlign: 'left' }}>Works with the AI CLIs you already use</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '1.02rem', lineHeight: 1.65, marginBottom: '1.5rem' }}>
              No bundled blobs, no proxy API. Kai probes <code>PATH</code> and runs your tools in a full interactive pty, under your user + keys.
            </p>
            <ul className="t-check-list">
              <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>codex / claude / gemini</strong> — auto-found, version shown.</span></li>
              <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>Full ANSI passthrough</strong> — TUIs render exactly like your shell.</span></li>
              <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>You control exec</strong> — visible process tree per tab.</span></li>
            </ul>
          </div>

          <div className="t-panel t-probe">
            <div className="t-probe-head"><span>$ kai --probe ai</span><span className="t-pill">3 found</span></div>
            <pre className="t-code t-code--sm"><code>{`✓ codex   /usr/local/bin/codex   v0.14.2
✓ claude  /usr/bin/claude         v1.0.4
✓ gemini  ~/.nvm/bin/gemini       v0.8.0
— 0 bundled binaries · PATH only`}</code></pre>
          </div>
        </div>
      </Section>

      {/* Compare + shortcuts */}
      <Section id="compare">
        <SectionHead
          title="How Kai compares"
          sub="Footprint, workflow, and privacy at a glance."
        />
        <div className="t-compare">
          <div className="t-panel t-table-wrap">
            <table className="t-table">
              <thead>
                <tr><th scope="col"><span className="t-sr">Feature</span></th><th scope="col" className="t-hl">kai</th><th scope="col">Electron apps</th><th scope="col">Alacritty</th></tr>
              </thead>
              <tbody>
                {COMPARE_ROWS.map((r) => (
                  <tr key={r.label}>
                    <th scope="row">{r.label}</th>
                    <td className="t-hl">{r.kai}</td>
                    <td>{r.electron}</td>
                    <td>{r.alacritty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="t-micro">Typical idle figures on the author's machine. Alacritty tabs/splits need tmux.</p>
          </div>
          <div className="t-panel">
            <div className="t-probe-head"><span>$ keyboard-first</span><span className="t-pill">remappable</span></div>
            <ul className="t-keys">
              {SHORTCUTS.map((s) => (
                <li key={s.label}>
                  <span>{s.label}</span>
                  <span className="t-kbd-group">
                    {s.keys.map((k) => <kbd key={k} className="t-kbd">{k}</kbd>)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="t-micro">Ctrl shown · macOS uses Cmd · change any binding in Settings.</p>
          </div>
        </div>
      </Section>

      {/* Downloads */}
      <Section id="downloads">
        <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
          <Badge tone="green"><PackageCheck size={14} /> GitHub Releases · SHA256</Badge>
          <h2 className="t-section-title">Download Kai</h2>
          <p className="t-section-sub">One file per OS. Built clean on GitHub Actions.</p>
        </div>

        <div className="t-grid-3" style={{ marginBottom: '1.5rem' }}>
          {[
            { os: 'Windows', sub: '10 / 11 · x64', href: rel.asset((n) => n.endsWith('-setup.exe') || (n.endsWith('.exe') && !n.endsWith('.msi')), `Kai_0.1.0_x64-setup.exe`), cta: `Kai_${rel.short}_x64-setup.exe`, alt: '.msi alternative', altHref: rel.asset((n) => n.endsWith('.msi'), `Kai_0.1.0_x64_en-US.msi`) },
            { os: 'Linux', sub: '.deb + .AppImage', href: rel.asset((n) => n.includes('amd64') && n.endsWith('.deb'), 'kai_0.1.0_amd64.deb'), cta: `kai_${rel.short}_amd64.deb`, alt: '.AppImage + ARM64 builds', altHref: LATEST_RELEASE_URL },
            { os: 'macOS', sub: '12+ · M1–M4', href: rel.asset((n) => n.endsWith('.dmg'), `Kai_0.1.0_aarch64.dmg`), cta: `Kai_${rel.short}_aarch64.dmg`, alt: 'checksums + changelog', altHref: LATEST_RELEASE_URL },
          ].map((d) => (
            <Card key={d.os} solid>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '.6rem' }}><Monitor size={20} /> {d.os}</h3>
              <p style={{ marginBottom: '1.25rem' }}>{d.sub}</p>
              <a className="t-dl t-dl--accent-cyan" href={d.href}><span>{d.cta}</span><Download size={16} /></a>
              <a className="t-link" style={{ marginTop: '.8rem', display: 'inline-flex' }} href={d.altHref} target={d.altHref.startsWith('http') ? '_blank' : undefined} rel="noreferrer">{d.alt} <ChevronRight size={14} /></a>
            </Card>
          ))}
        </div>

        <div className="t-panel t-verify">
          <div><b>Verify + see all artifacts</b><p>Changelog, SHA256, full tag history.</p></div>
          <a href={LATEST_RELEASE_URL} target="_blank" rel="noreferrer" className="t-btn t-btn--primary t-btn--sm">Releases <ExternalLink size={16} /></a>
        </div>
      </Section>

      {/* FAQ */}
      <Section id="faq" alt>
        <div className="t-container-narrow" style={{ padding: 0 }}>
          <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
            <Badge tone="neutral"><HelpCircle size={14} /> FAQ</Badge>
            <h2 className="t-section-title">Frequently asked questions</h2>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.9rem' }}>
            {faqItems.map((item, idx) => (
              <div
                key={idx}
                role="button"
                tabIndex={0}
                aria-expanded={activeFaq === idx}
                onClick={() => setActiveFaq(activeFaq === idx ? null : idx)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setActiveFaq(activeFaq === idx ? null : idx);
                  }
                }}
                className="t-faq-item"
                data-open={activeFaq === idx}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                  <h3 style={{ fontSize: '1rem', fontWeight: 700 }}>{item.q}</h3>
                  <span style={{ fontSize: '1.25rem', color: 'var(--text-tertiary)', transform: activeFaq === idx ? 'rotate(45deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>+</span>
                </div>
                {activeFaq === idx && <p className="t-faq-a">{item.a}</p>}
              </div>
            ))}
          </div>
        </div>
      </Section>

      </main>
      {/* Footer */}
      <footer className="t-footer">
        <div style={{ maxWidth: '1150px', margin: '0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <div className="t-brand-mark" style={{ width: '28px', height: '28px', borderRadius: '8px' }}><Terminal size={16} color="#ffffff" /></div>
            <span style={{ fontSize: '1.1rem', fontWeight: 800 }}>kai</span>
            <span className="t-version">MIT</span>
          </div>
          <p style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: '.82rem' }}>$ git clone {REPO_URL}.git — PRs welcome</p>
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', justifyContent: 'center' }}>
            <a href="#quickstart" style={{ color: 'inherit', textDecoration: 'none' }}>Quickstart</a>
            <a href="#downloads" style={{ color: 'inherit', textDecoration: 'none' }}>Download</a>
            <a href={REPO_URL} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>GitHub</a>
            <a href={`${REPO_URL}/issues`} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>Issues</a>
            <a href={LATEST_RELEASE_URL} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>Releases</a>
          </div>
          <div style={{ borderTop: '1px solid var(--border-subtle)', width: '100%', paddingTop: '1.25rem', textAlign: 'center', fontSize: '0.78rem', color: 'var(--text-tertiary)' }}>
            © 2026 Kai Contributors · MIT
          </div>
        </div>
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <SiteContent />
    </ThemeProvider>
  );
}
