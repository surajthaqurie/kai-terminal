import React, { useState } from 'react';
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
  Globe,
  Code2,
  ExternalLink,
  PackageCheck,
  HelpCircle,
  ArrowRight,
  Sun,
  Moon,
  Menu,
  X,
} from 'lucide-react';
import { ThemeProvider, useTheme } from './theme/ThemeContext';
import { Badge, Button, Card, Section, SectionHead } from './components/ui';

const REPO_URL = 'https://github.com/surajthaqurie/kai-terminal';
const LATEST_RELEASE_URL = `${REPO_URL}/releases/latest`;

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

function SiteHeader() {
  const [open, setOpen] = useState(false);
  return (
    <header className="t-header">
      <div className="t-header-inner" style={{ position: 'relative' }}>
        <a className="t-brand" href="#top" aria-label="Kai home">
          <div className="t-brand-mark">
            <Terminal size={22} color="#ffffff" />
          </div>
          <div>
            <span className="t-brand-name">Kai</span>
            <span className="t-version">v0.1.0 MIT</span>
          </div>
        </a>

        <nav className="t-nav" data-open={open} aria-label="Primary">
          <a href="#features" onClick={() => setOpen(false)}>Features</a>
          <a href="#ai-cli" onClick={() => setOpen(false)}>AI Integration</a>
          <a href="#architecture" onClick={() => setOpen(false)}>Architecture</a>
          <a href="#downloads" onClick={() => setOpen(false)}>Downloads</a>
          <a href="#faq" onClick={() => setOpen(false)}>FAQ</a>
        </nav>

        <div className="t-header-actions">
          <ThemeToggle />
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="t-btn t-btn--secondary t-btn--sm">
            <Github size={16} /> <span className="t-header-cta-label">GitHub</span>
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

function HeroTerminal() {
  const [terminalInput, setTerminalInput] = useState('');
  const [terminalHistory, setTerminalHistory] = useState<
    Array<{ cmd: string; output: React.ReactNode }>
  >([
    {
      cmd: 'kai --status',
      output: (
        <div className="text-emerald-400 space-y-1" style={{ color: '#34d399' }}>
          <p>✔ Rust PTY Engine: Active (portable-pty 0.8)</p>
          <p>✔ Session Isolation: Multi-tab process sandboxing</p>
          <p>✔ AI CLI Probe: Local PATH detection active (0 bundled binaries)</p>
          <p>✔ License: 100% Free &amp; Open-Source (MIT)</p>
        </div>
      ),
    },
  ]);

  const handleTerminalSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const rawInput = terminalInput.trim();
    const input = rawInput.toLowerCase();
    if (!input) return;

    let reply: React.ReactNode = '';
    if (input === 'help' || input === 'kai --help' || input === 'kai -h' || input === '?') {
      reply = (
        <div style={{ color: '#67e8f9' }}>
          <p>Available interactive demo commands:</p>
          <p>• <span style={{ color: '#fcd34d', fontWeight: 700 }}>kai --status</span> (or status) - Check PTY engine &amp; IPC health</p>
          <p>• <span style={{ color: '#fcd34d', fontWeight: 700 }}>claude</span> - Check local Claude Code CLI connection status</p>
          <p>• <span style={{ color: '#fcd34d', fontWeight: 700 }}>codex</span> - Check local OpenAI Codex CLI probe status</p>
          <p>• <span style={{ color: '#fcd34d', fontWeight: 700 }}>gemini</span> - Check local Gemini CLI status</p>
          <p>• <span style={{ color: '#fcd34d', fontWeight: 700 }}>downloads</span> - List release packages for Windows, Linux, macOS</p>
          <p>• <span style={{ color: '#fcd34d', fontWeight: 700 }}>license</span> | <span style={{ color: '#fcd34d', fontWeight: 700 }}>clear</span> | <span style={{ color: '#fcd34d', fontWeight: 700 }}>whoami</span></p>
        </div>
      );
    } else if (input === 'status' || input === 'kai --status' || input === 'kai status' || input === 'kai -s') {
      reply = (
        <div style={{ color: '#34d399' }}>
          <p>✔ Kai Engine: Operational (v0.1.0)</p>
          <p>✔ Rust PTY Driver: Active (portable-pty 0.8 / ConPTY / POSIX)</p>
          <p>✔ Render Loop: xterm.js Canvas GPU viewport @ 60 FPS</p>
          <p>✔ Session Sandboxing: Isolated tab handle security active</p>
          <p>✔ Local AI Probe: 3 AI CLIs detected on system PATH</p>
        </div>
      );
    } else if (input === 'claude' || input === 'claude code' || input === 'connect claude' || input === 'kai claude') {
      reply = (
        <div style={{ color: '#d8b4fe' }}>
          <p style={{ fontWeight: 600, color: '#e9d5ff' }}>🤖 Claude Code CLI Connection Status:</p>
          <p>• Binary: <span style={{ color: '#34d399', fontFamily: 'Fira Code, monospace' }}>/usr/bin/claude</span> (Detected via PATH)</p>
          <p>• PTY Handle: Native Rust PTY channel bound</p>
          <p>• Mode: Full ANSI terminal interactive session ready</p>
          <p style={{ color: '#94a3b8', fontSize: '0.75rem', fontStyle: 'italic' }}>* Kai launches Claude in your working directory with full terminal capabilities.</p>
        </div>
      );
    } else if (input === 'codex' || input === 'codex cli' || input === 'connect codex' || input === 'kai codex') {
      reply = (
        <div style={{ color: '#93c5fd' }}>
          <p style={{ fontWeight: 600, color: '#bfdbfe' }}>🤖 OpenAI Codex CLI Connection Status:</p>
          <p>• Binary: <span style={{ color: '#34d399', fontFamily: 'Fira Code, monospace' }}>/usr/local/bin/codex</span> (Detected via PATH)</p>
          <p>• PTY Handle: Bounded local process execution</p>
          <p>• Mode: Interactive code generation &amp; terminal assist ready</p>
        </div>
      );
    } else if (input === 'gemini' || input === 'gemini cli' || input === 'connect gemini' || input === 'kai gemini') {
      reply = (
        <div style={{ color: '#6ee7b7' }}>
          <p style={{ fontWeight: 600, color: '#a7f3d0' }}>🤖 Gemini CLI Connection Status:</p>
          <p>• Binary: <span style={{ color: '#34d399', fontFamily: 'Fira Code, monospace' }}>~/.nvm/versions/bin/gemini</span> (Detected via PATH)</p>
          <p>• Mode: Multimodal developer assistant ready</p>
        </div>
      );
    } else if (input === 'ai' || input === 'kai ai' || input === 'kai --ai') {
      reply = (
        <div style={{ color: '#d8b4fe' }}>
          <p style={{ fontWeight: 600, color: '#e9d5ff' }}>Local System PATH AI CLI Probe Results:</p>
          <p>• Codex CLI: <span style={{ color: '#34d399' }}>Available</span> (/usr/local/bin/codex)</p>
          <p>• Claude Code: <span style={{ color: '#34d399' }}>Available</span> (/usr/bin/claude)</p>
          <p>• Gemini CLI: <span style={{ color: '#34d399' }}>Available</span> (~/.nvm/versions/bin/gemini)</p>
          <p style={{ color: '#94a3b8', fontSize: '0.75rem', fontStyle: 'italic' }}>* Kai never bundles AI binaries. You control all execution &amp; keys.</p>
        </div>
      );
    } else if (input === 'downloads' || input === 'download' || input === 'kai downloads') {
      reply = (
        <div style={{ color: '#67e8f9' }}>
          <p style={{ fontWeight: 600, color: '#a5f3fc' }}>Official Kai Release Installers (v0.1.0):</p>
          <p>• Windows: .exe (NSIS Installer), .msi (64-bit Package)</p>
          <p>• Linux: .deb (Ubuntu/Debian x64 &amp; ARM64), .AppImage (x64 &amp; ARM64)</p>
          <p>• macOS: .dmg (Apple Silicon M1-M4)</p>
        </div>
      );
    } else if (input === 'version' || input === 'kai --version' || input === 'kai -v') {
      reply = <p style={{ color: '#67e8f9' }}>Kai v0.1.0 (Tauri 2.1.0 + Rust PTY backend, MIT License)</p>;
    } else if (input === 'whoami' || input === 'kai') {
      reply = <p style={{ color: '#cbd5e1' }}>kai@kai-workstation</p>;
    } else if (input === 'ls' || input === 'dir') {
      reply = <p style={{ color: '#94a3b8', fontFamily: 'Fira Code, monospace' }}>src/  src-tauri/  packaging/  Cargo.toml  package.json  README.md</p>;
    } else if (input === 'license') {
      reply = <p style={{ color: '#fcd34d' }}>MIT License — Copyright (c) 2026 Kai Contributors. 100% Free &amp; Open Source.</p>;
    } else if (input === 'clear' || input === 'cls') {
      setTerminalHistory([]);
      setTerminalInput('');
      return;
    } else {
      reply = <p style={{ color: '#fb7185' }}>Command not found: &apos;{rawInput}&apos;. Type &apos;help&apos; or &apos;kai --status&apos; for commands.</p>;
    }

    setTerminalHistory((prev) => [...prev, { cmd: rawInput, output: reply }]);
    setTerminalInput('');
  };

  const chips: Array<{ label: string; value: string; bg: string; fg: string; border: string }> = [
    { label: 'kai --status', value: 'kai --status', bg: 'rgba(6,182,212,0.12)', fg: '#22d3ee', border: 'rgba(6,182,212,0.3)' },
    { label: 'claude', value: 'claude', bg: 'rgba(168,85,247,0.12)', fg: '#c084fc', border: 'rgba(168,85,247,0.3)' },
    { label: 'ai', value: 'ai', bg: 'rgba(255,255,255,0.06)', fg: '#94a3b8', border: 'rgba(255,255,255,0.08)' },
    { label: 'downloads', value: 'downloads', bg: 'rgba(255,255,255,0.06)', fg: '#94a3b8', border: 'rgba(255,255,255,0.08)' },
  ];

  return (
    <div className="t-terminal" role="region" aria-label="Interactive Kai demo terminal">
      <div className="t-terminal-bar">
        <div className="t-terminal-dots">
          <span className="t-dot" style={{ backgroundColor: '#ef4444' }}></span>
          <span className="t-dot" style={{ backgroundColor: '#f59e0b' }}></span>
          <span className="t-dot" style={{ backgroundColor: '#10b981' }}></span>
          <span className="t-terminal-title">kai ~ bash (portable-pty 0.8)</span>
        </div>
        <div className="t-terminal-chips">
          {chips.map((c) => (
            <button
              key={c.label}
              type="button"
              onClick={() => setTerminalInput(c.value)}
              className="t-chip"
              style={{ backgroundColor: c.bg, color: c.fg, border: `1px solid ${c.border}` }}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div className="t-terminal-view">
        {terminalHistory.map((item, idx) => (
          <div key={idx} className="t-term-line">
            <div className="t-term-prompt">
              <span>user@kai:~$</span>
              <span className="t-term-cmd">{item.cmd}</span>
            </div>
            <div className="t-term-out">{item.output}</div>
          </div>
        ))}

        <form onSubmit={handleTerminalSubmit} className="t-term-form">
          <span style={{ color: '#38bdf8' }}>user@kai:~$</span>
          <input
            type="text"
            value={terminalInput}
            onChange={(e) => setTerminalInput(e.target.value)}
            placeholder="Try typing 'help', 'status', 'ai', or 'downloads'..."
            className="t-term-input"
            aria-label="Demo terminal input"
          />
        </form>
      </div>
    </div>
  );
}

const FEATURES = [
  { icon: Cpu, tone: 't-icon--cyan', title: 'Rust PTY Core (`portable-pty`)', body: 'Direct OS pseudo-terminal streaming without Node.js backend overhead. Supports POSIX PTY on Linux/macOS and ConPTY on Windows.' },
  { icon: Bot, tone: 't-icon--purple', title: 'Safe Local AI CLI Detection', body: 'Probes local PATH safely for installed AI CLIs (Codex, Claude Code, Gemini). Zero bundled binaries, keeping you in total control.' },
  { icon: Layers, tone: 't-icon--green', title: 'Multi-Tab Process Isolation', body: 'Each terminal tab runs with isolated working directory handles, independent child process trees, and dedicated PTY channels.' },
  { icon: ShieldCheck, tone: 't-icon--amber', title: 'Zero Telemetry & Secret Shield', body: 'No tracking cookies, no background analytics, and no remote keystroke logging. Strict Content Security Policy (CSP) enforced.' },
  { icon: Zap, tone: 't-icon--pink', title: 'GPU Accelerated Rendering', body: '60 FPS smooth rendering powered by `@xterm/xterm` canvas engine, fast text selection, search addon, and automatic grid fitting.' },
  { icon: Globe, tone: 't-icon--blue', title: '100% Free MIT Open Source', body: 'Free for all personal and enterprise workloads. Reproducible native installer builds compiled automatically on GitHub.' },
];

function SiteContent() {
  const [activeFaq, setActiveFaq] = useState<number | null>(null);

  const faqItems = [
    { q: 'Is Kai 100% free and open-source?', a: 'Yes! Kai is released under the permissive MIT License. It is completely free for personal, educational, and commercial use with no hidden fees or paywalls.' },
    { q: 'Does Kai collect telemetry or log terminal output?', a: 'No. Kai enforces a strict Zero Telemetry policy. Your keystrokes, environment variables, command history, and session data remain strictly local to your machine.' },
    { q: 'How does local AI CLI integration work?', a: 'Kai automatically probes your local system PATH for AI tools you already have installed (such as Codex CLI, Claude Code, or Gemini CLI). It does not bundle heavy external AI binaries or force subscriptions.' },
    { q: 'Why use Tauri 2 + Rust instead of Electron?', a: 'By leveraging Tauri 2 and native Rust PTY streams (portable-pty), Kai consumes under 30MB of RAM at idle compared to 300MB+ for typical Electron terminal emulators, delivering faster startup times and lower CPU usage.' },
    { q: 'Which operating systems and package formats are supported?', a: 'Kai provides native installers for Windows (.exe NSIS, .msi), Linux (.deb x64/ARM64, .AppImage x64/ARM64), and macOS (.dmg for Apple Silicon M1-M4).' },
  ];

  return (
    <div id="top" style={{ backgroundColor: 'var(--bg-canvas)', color: 'var(--text-primary)', minHeight: '100vh', transition: 'background-color .25s ease, color .25s ease' }}>
      <SiteHeader />

      {/* Hero */}
      <section className="t-hero">
        <div className="t-hero-glow"></div>
        <div className="t-hero-inner">
          <Badge><Sparkles size={14} /> One terminal. Every platform.</Badge>

          <h1 className="t-hero-title">
            Kai Terminal<br />One terminal. Every platform.
          </h1>

          <p className="t-hero-sub">
            A modern cross-platform terminal for Windows, Linux, and macOS. Powered by <strong>Tauri 2</strong>, memory-safe <strong>Rust PTY streams (`portable-pty`)</strong>, and GPU-accelerated <strong>xterm.js</strong>.
          </p>

          <div className="t-hero-cta">
            <Button href="#downloads"><Download size={18} /> Download Free Release <ArrowRight size={16} /></Button>
            <Button href={REPO_URL} variant="secondary"><Code2 size={18} /> Source Code</Button>
          </div>

          <HeroTerminal />
        </div>
      </section>

      {/* Features */}
      <Section id="features" alt>
        <SectionHead
          title="Architected for Pure Performance"
          sub="Combining memory-safe Rust execution with hardware-accelerated frontend rendering."
        />
        <div className="t-grid-3">
          {FEATURES.map((f) => (
            <Card key={f.title} hover>
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
      <Section id="ai-cli">
        <div className="t-split">
          <div>
            <Badge tone="purple"><Bot size={14} /> Seamless AI Workflow</Badge>
            <h2 className="t-section-title" style={{ textAlign: 'left' }}>Designed for Developer AI Tools</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '1.05rem', lineHeight: 1.65, marginBottom: '1.75rem' }}>
              Kai respects your environment. Rather than forcing proprietary AI APIs or bundling opaque binary blobs, Kai detects local CLI tools already installed on your system.
            </p>
            <ul className="t-check-list">
              <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>Codex CLI / Claude Code / Gemini CLI:</strong> Automatically discovered via local system PATH.</span></li>
              <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>Zero Vendor Lock-in:</strong> Works out of the box with standard shell tools and customized aliases.</span></li>
              <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>User Controlled Execution:</strong> AI commands run under your permissions with full interactive terminal visibility.</span></li>
            </ul>
          </div>

          <div className="t-panel">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '1rem', marginBottom: '1rem' }}>
              <span style={{ fontSize: '0.9rem', fontWeight: 700 }}>Local AI CLI Probe Diagnostics</span>
              <span style={{ fontSize: '0.75rem', color: 'var(--accent-green-fg)', backgroundColor: 'var(--accent-green-bg)', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>Active</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {[
                { name: 'Codex CLI', detail: 'Path: /usr/local/bin/codex • Version: 0.14.2', color: '#a855f7' },
                { name: 'Claude Code CLI', detail: 'Path: /usr/bin/claude • Version: 1.0.4', color: '#38bdf8' },
                { name: 'Gemini CLI', detail: 'Path: ~/.nvm/versions/bin/gemini • Version: 0.8.0', color: '#34d399' },
              ].map((r) => (
                <div key={r.name} className="t-mono-row" style={{ color: 'var(--text-secondary)' }}>
                  <div style={{ color: r.color, fontWeight: 600 }}>{r.name}</div>
                  <div style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem', marginTop: '0.2rem' }}>{r.detail}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>

      {/* Architecture strip */}
      <Section id="architecture" alt>
        <SectionHead
          badge={<Badge tone="neutral">Tauri 2 • Rust • React • xterm.js</Badge>}
          title="Lightweight by Architecture, Not by Compromise"
          sub="Under 30MB idle RAM. Native PTY streams, GPU canvas rendering, and strict session isolation."
        />
        <div className="t-grid-3">
          <Card><h3>~30MB idle footprint</h3><p>Tauri 2 webview shell plus a native Rust backend — no bundled Chromium, no Electron overhead.</p></Card>
          <Card><h3>Native PTY everywhere</h3><p>portable-pty on POSIX, ConPTY on Windows. Direct byte streams with full ANSI fidelity.</p></Card>
          <Card><h3>Isolated by default</h3><p>Per-tab working directories and process trees. Zero telemetry, strict CSP, local-first secrets.</p></Card>
        </div>
      </Section>

      {/* Downloads */}
      <Section id="downloads">
        <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
          <Badge tone="green"><PackageCheck size={14} /> Official Pre-built Installers</Badge>
          <h2 className="t-section-title">Download Kai for Your Platform</h2>
          <p className="t-section-sub">Native release packages built directly on clean GitHub Actions runners.</p>
        </div>

        <div className="t-grid-3" style={{ marginBottom: '2rem' }}>
          <Card solid>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', marginBottom: '1.25rem' }}>
              <div style={{ padding: '0.65rem', borderRadius: '12px', backgroundColor: 'var(--accent-cyan-bg)' }}><Monitor size={28} color="var(--accent-cyan-fg)" /></div>
              <div><h3 style={{ margin: 0 }}>Windows</h3><span style={{ fontSize: '0.825rem', color: 'var(--text-secondary)' }}>Windows 10 / 11 (x86_64)</span></div>
            </div>
            <p style={{ marginBottom: '1.75rem' }}>Native ConPTY support for PowerShell Core, CMD, Git Bash, and WSL environment integration.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <a className="t-dl t-dl--accent-cyan" href={`${LATEST_RELEASE_URL}/download/Kai_0.1.0_x64-setup.exe`}><span>Download NSIS Installer (.exe)</span><Download size={16} /></a>
              <a className="t-dl" href={`${LATEST_RELEASE_URL}/download/Kai_0.1.0_x64_en-US.msi`}><span>Download MSI Package (.msi)</span><Download size={16} /></a>
            </div>
          </Card>

          <Card solid>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', marginBottom: '1.25rem' }}>
              <div style={{ padding: '0.65rem', borderRadius: '12px', backgroundColor: 'var(--accent-green-bg)' }}><Terminal size={28} color="var(--accent-green-fg)" /></div>
              <div><h3 style={{ margin: 0 }}>Linux</h3><span style={{ fontSize: '0.825rem', color: 'var(--text-secondary)' }}>Ubuntu / Debian / Arch / Fedora</span></div>
            </div>
            <p style={{ marginBottom: '1.75rem' }}>Debian `.deb` packages (x64 &amp; ARM64) and standalone `.AppImage` builds, each compiled natively on GitHub runners.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <a className="t-dl t-dl--accent-green" href={`${LATEST_RELEASE_URL}/download/kai_0.1.0_amd64.deb`}><span>Debian / Ubuntu Package (.deb x64)</span><Download size={16} /></a>
              <a className="t-dl" href={`${LATEST_RELEASE_URL}/download/kai_0.1.0_amd64.AppImage`}><span>Portable Linux AppImage (.AppImage x64)</span><Download size={16} /></a>
              <a className="t-dl" href={`${LATEST_RELEASE_URL}/download/kai_0.1.0_arm64.deb`}><span>Debian ARM64 Package (.deb ARM64)</span><Download size={16} /></a>
              <a className="t-dl" href={`${LATEST_RELEASE_URL}/download/kai_0.1.0_arm64.AppImage`}><span>Portable Linux AppImage (.AppImage ARM64)</span><Download size={16} /></a>
            </div>
          </Card>

          <Card solid>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', marginBottom: '1.25rem' }}>
              <div style={{ padding: '0.65rem', borderRadius: '12px', backgroundColor: 'var(--accent-purple-bg)' }}><Globe size={28} color="var(--accent-purple-fg)" /></div>
              <div><h3 style={{ margin: 0 }}>macOS</h3><span style={{ fontSize: '0.825rem', color: 'var(--text-secondary)' }}>macOS 12.0+ Monterey or later</span></div>
            </div>
            <p style={{ marginBottom: '1.75rem' }}>Native Apple Silicon build (M1/M2/M3/M4). Supports Zsh, Bash, and Fish shells.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <a className="t-dl t-dl--accent-purple" href={`${LATEST_RELEASE_URL}/download/Kai_0.1.0_aarch64.dmg`}><span>Apple Silicon DMG (M1/M2/M3/M4)</span><Download size={16} /></a>
            </div>
          </Card>
        </div>

        <div className="t-panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
            <div style={{ padding: '0.85rem', borderRadius: '12px', backgroundColor: 'var(--accent-cyan-bg)', color: 'var(--accent-cyan-fg)' }}><Github size={26} /></div>
            <div>
              <h4 style={{ fontSize: '1.15rem', fontWeight: 700 }}>All Release Artifacts &amp; SHA256 Checksums</h4>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '0.2rem' }}>Inspect full changelogs, build verification hashes, and tag history on GitHub.</p>
            </div>
          </div>
          <a href={LATEST_RELEASE_URL} target="_blank" rel="noreferrer" className="t-btn t-btn--primary t-btn--sm">View GitHub Releases <ExternalLink size={16} /></a>
        </div>
      </Section>

      {/* FAQ */}
      <Section id="faq" alt>
        <div className="t-container-narrow" style={{ padding: 0 }}>
          <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
            <Badge tone="neutral"><HelpCircle size={14} /> Clear Answers</Badge>
            <h2 className="t-section-title">Frequently Asked Questions</h2>
            <p className="t-section-sub">Everything you need to know about Kai features, privacy, and performance.</p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {faqItems.map((item, idx) => (
              <div key={idx} onClick={() => setActiveFaq(activeFaq === idx ? null : idx)} className="t-faq-item" data-open={activeFaq === idx}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                  <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>{item.q}</h3>
                  <span style={{ fontSize: '1.25rem', color: 'var(--text-tertiary)', transform: activeFaq === idx ? 'rotate(45deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>+</span>
                </div>
                {activeFaq === idx && <p className="t-faq-a">{item.a}</p>}
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* Footer */}
      <footer className="t-footer">
        <div style={{ maxWidth: '1150px', margin: '0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <div className="t-brand-mark" style={{ width: '28px', height: '28px', borderRadius: '8px' }}><Terminal size={16} color="#ffffff" /></div>
            <span style={{ fontSize: '1.15rem', fontWeight: 800, color: 'var(--text-primary)' }}>Kai</span>
          </div>
          <p style={{ maxWidth: '600px', textAlign: 'center', color: 'var(--text-secondary)' }}>
            A modern cross-platform terminal for Windows, Linux, and macOS. Released under the permissive MIT license.
          </p>
          <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', justifyContent: 'center', color: 'var(--text-secondary)' }}>
            <a href="#features" style={{ color: 'inherit', textDecoration: 'none' }}>Features</a>
            <a href="#ai-cli" style={{ color: 'inherit', textDecoration: 'none' }}>AI Integration</a>
            <a href="#downloads" style={{ color: 'inherit', textDecoration: 'none' }}>Installers for All OS</a>
            <a href="#faq" style={{ color: 'inherit', textDecoration: 'none' }}>FAQ</a>
            <a href={REPO_URL} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>GitHub Repository</a>
          </div>
          <div style={{ borderTop: '1px solid var(--border-subtle)', width: '100%', paddingTop: '1.5rem', textAlign: 'center', fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
            Copyright © 2026 Kai Contributors. All rights reserved.
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
