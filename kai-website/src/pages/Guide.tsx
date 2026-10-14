import { BookOpen, Terminal, ArrowRight } from 'lucide-react';
import { PageHero } from '../components/PageHero';
import { Container, Reveal, Badge } from '../components/ui';
import { SHORTCUTS } from '../data/site';
import { CopyBtn } from '../components/CopyBtn';
import { CtaBanner } from '../components/CtaBanner';
import { Link } from '../router';

export function GuidePage() {
  return (
    <>
      <PageHero
        badge={<><BookOpen size={14} /> Getting Started</>}
        title="Developer Setup Guide"
        sub="A straightforward guide to installing Kai, starting your first session, and connecting external AI coding agents."
      />

      <section className="t-section" style={{ paddingTop: '1rem', paddingBottom: '3.5rem' }}>
        <Container narrow>
          {/* Quick Step 1: Installation */}
          <Reveal>
            <div className="t-manual-card">
              <div className="t-manual-card-header">
                <div>
                  <Badge tone="cyan">Step 01</Badge>
                  <h2 style={{ fontSize: '1.35rem', fontWeight: 800 }}>Install Kai Terminal</h2>
                </div>
              </div>
              <p style={{ color: 'var(--text-secondary)', lineHeight: 1.65, marginBottom: '1.25rem' }}>
                Kai is distributed as a standalone, native desktop application for macOS, Linux, and Windows. No account registration or cloud sign-up is required.
              </p>

              <div className="t-grid-3" style={{ gap: '1rem', marginBottom: '1.5rem' }}>
                <div className="t-card" style={{ padding: '1.25rem' }}>
                  <h3 style={{ fontSize: '1rem', marginBottom: '0.4rem' }}>macOS</h3>
                  <p style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', margin: 0 }}>
                    Apple Silicon (M1–M4) disk image (<code>.dmg</code>). Drag into Applications.
                  </p>
                </div>
                <div className="t-card" style={{ padding: '1.25rem' }}>
                  <h3 style={{ fontSize: '1rem', marginBottom: '0.4rem' }}>Linux</h3>
                  <p style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', margin: 0 }}>
                    Debian/Ubuntu package (<code>.deb</code>) or portable <code>.AppImage</code> for x86_64 and ARM64.
                  </p>
                </div>
                <div className="t-card" style={{ padding: '1.25rem' }}>
                  <h3 style={{ fontSize: '1rem', marginBottom: '0.4rem' }}>Windows</h3>
                  <p style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', margin: 0 }}>
                    Standard Windows installer (<code>.exe</code>) or system package (<code>.msi</code>).
                  </p>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
                <span style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
                  Ready to download the binary for your operating system?
                </span>
                <Link to="/download" className="t-btn t-btn--primary t-btn--sm">
                  View Downloads <ArrowRight size={14} />
                </Link>
              </div>
            </div>
          </Reveal>

          {/* Quick Step 2: First Launch */}
          <Reveal>
            <div className="t-manual-card">
              <div className="t-manual-card-header">
                <div>
                  <Badge tone="purple">Step 02</Badge>
                  <h2 style={{ fontSize: '1.35rem', fontWeight: 800 }}>Launch Kai Terminal</h2>
                </div>
              </div>
              <p style={{ color: 'var(--text-secondary)', lineHeight: 1.65, marginBottom: '1rem' }}>
                From any standard shell (Bash, Zsh, or PowerShell), run <code>kai open</code> to launch the Kai Terminal desktop application. Kai starts the hardware-accelerated UI and registers your project workspace in <code>~/.kai/</code>.
              </p>

              <div className="t-panel" style={{ padding: '0.85rem 1.25rem', marginBottom: '0.75rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <code style={{ fontSize: '0.86rem', color: 'var(--accent-cyan-fg)' }}>kai open</code>
                  <CopyBtn text="kai open" />
                </div>
              </div>

              <p style={{ fontSize: '0.84rem', color: 'var(--text-tertiary)', margin: '0.5rem 0 0' }}>
                To open a specific project folder instead of the current directory, specify the target directory: <code>kai open /path/to/project</code>.
              </p>
            </div>
          </Reveal>

          {/* Quick Step 3: Run AI Agent */}
          <Reveal>
            <div className="t-manual-card">
              <div className="t-manual-card-header">
                <div>
                  <Badge tone="green">Step 03</Badge>
                  <h2 style={{ fontSize: '1.35rem', fontWeight: 800 }}>Run Your AI Coding Agent</h2>
                </div>
              </div>
              <p style={{ color: 'var(--text-secondary)', lineHeight: 1.65, marginBottom: '1rem' }}>
                Inside Kai Terminal, launch your preferred coding agent. Kai automatically wires its local Model Context Protocol (MCP) server, primes the AST code graph, and activates git commit hooks to strip AI co-author trailers.
              </p>

              <div className="t-panel" style={{ padding: '0.85rem 1.25rem', marginBottom: '0.75rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <code style={{ fontSize: '0.86rem', color: 'var(--accent-cyan-fg)' }}>kai claude .</code>
                  <CopyBtn text="kai claude ." />
                </div>
              </div>

              <div style={{ marginTop: '1.25rem', paddingTop: '1rem', borderTop: '1px solid var(--border-subtle)' }}>
                <p style={{ fontSize: '0.86rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                  <strong>Supported agents:</strong> <code>claude</code>, <code>cursor</code>, <code>codex</code>, <code>gemini</code>, <code>opencode</code>, <code>aider</code>, <code>windsurf</code>, <code>cline</code>, <code>copilot</code>, and <code>agy</code>.
                </p>
                <p style={{ fontSize: '0.84rem', color: 'var(--text-tertiary)', margin: 0 }}>
                  You can also run <code>kai setup all</code> inside Kai Terminal to configure all detected agents at once.
                </p>
              </div>
            </div>
          </Reveal>

          {/* Dedicated Manual Callout */}
          <Reveal>
            <div className="t-guide-callout" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', padding: '1.5rem' }}>
              <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                <Terminal size={24} style={{ color: 'var(--accent-cyan-fg)', flexShrink: 0 }} />
                <div>
                  <strong style={{ fontSize: '1rem' }}>Looking for the complete command reference?</strong>
                  <p style={{ margin: '0.2rem 0 0', fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
                    Detailed options, environment boundaries, diagnostics, and the searchable cheatsheet live in our dedicated User Manual.
                  </p>
                </div>
              </div>
              <Link to="/manual" className="t-btn t-btn--primary t-btn--sm" style={{ marginTop: '0.5rem' }}>
                Open User Manual & Cheatsheet <ArrowRight size={14} />
              </Link>
            </div>
          </Reveal>
        </Container>
      </section>

      {/* Keyboard Shortcuts Section */}
      <section className="t-section t-section-alt" id="shortcuts">
        <Container narrow>
          <Reveal>
            <div className="t-section-head">
              <Badge tone="neutral">Productivity</Badge>
              <h2 className="t-section-title">Essential Shortcuts</h2>
              <p className="t-section-sub">Default key combinations. Remappable anytime in Settings.</p>
            </div>
            <div className="t-panel">
              <div className="t-probe-head"><span>Terminal Shortcuts</span><span className="t-pill">Ctrl / Cmd</span></div>
              <ul className="t-keys">
                {SHORTCUTS.map((s) => (
                  <li key={s.label}>
                    <span className="t-keys-label">{s.label}</span>
                    <span className="t-kbd-group">
                      {s.keys.map((k) => <kbd key={k} className="t-kbd">{k}</kbd>)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="t-micro">Keys show Ctrl on Linux/Windows — use Cmd (⌘) on macOS.</p>
            </div>
          </Reveal>
        </Container>
      </section>

      <CtaBanner />
    </>
  );
}
