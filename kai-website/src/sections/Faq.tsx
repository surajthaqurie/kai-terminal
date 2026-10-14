import { useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { Badge, Section } from '../components/ui';

const FAQ_ITEMS = [
  { q: 'What is Kai?', a: 'Kai is an ultra-fast cross-platform desktop terminal (Tauri 2 + Rust) featuring hardware-accelerated WebGL 60fps rendering, native PTY support (ConPTY on Windows, POSIX pty on macOS/Linux), and a local project intelligence engine designed for AI coding agents. MIT licensed.' },
  { q: 'What does it cost? Is there tracking or telemetry?', a: '100% free and MIT licensed with no accounts, cloud subscriptions, or telemetry tracking. Project AST indexes, symbol caches, and configurations stay exclusively in ~/.kai/ on your computer. .env files, credentials, and binary files are automatically skipped.' },
  { q: 'How do I start?', a: 'Download the installer for your OS, open your terminal, and run kai open [path] to launch Kai Terminal on your repository. Inside Kai Terminal, launch your agent directly (e.g. kai claude . or kai cursor .) or run kai setup all. See the User Manual for every command.' },
  { q: 'Which AI coding agents are supported?', a: 'Kai supports 10 AI coding tools: Claude Code (claude), Cursor (cursor), Codex CLI (codex), Gemini CLI (gemini), OpenCode (opencode), Aider (aider), Windsurf (windsurf), Cline (cline), GitHub Copilot, and Antigravity (agy). Kai auto-wires MCP configurations and performs AST graph auto-sync upon session exit.' },
  { q: 'What makes Kai different from standard terminals?', a: 'Kai pairs a high-performance 60fps WebGL GPU terminal engine (~30MB idle RAM, zero-remount flat grid split panes, and pointer-based tab drag reordering) with integrated AI agent orchestration. Kai automatically manages AST code graphs, bridges local Language Server Protocol (LSP) servers, and strips AI co-author trailers via commit-msg git hooks.' },
  { q: 'Which files do I download?', a: 'macOS: .dmg (Apple Silicon M1–M4). Linux: .deb for Ubuntu/Debian or .AppImage for Fedora, Arch, and portable use (x86_64 and ARM64). Windows: .exe or .msi (x64).' },
  { q: 'macOS says "kai is damaged"?', a: 'The .dmg is unsigned, so macOS Gatekeeper blocks it — the binary is intact. Eject the image, run xattr -d com.apple.quarantine on the .dmg, reopen it, drag Kai to Applications, then run xattr -cr /Applications/Kai.app and right-click Kai > Open once.' },
];

export function Faq() {
  const [activeFaq, setActiveFaq] = useState<number | null>(0);
  return (
    <Section id="faq" alt>
      <div className="t-container-narrow" style={{ padding: 0 }}>
        <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
          <Badge tone="neutral"><HelpCircle size={14} /> FAQ</Badge>
          <h2 className="t-section-title">Questions</h2>
          <p className="t-section-sub">Straight answers. Click to expand.</p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.9rem' }}>
          {FAQ_ITEMS.map((item, idx) => {
            const open = activeFaq === idx;
            const panelId = `faq-panel-${idx}`;
            const btnId = `faq-btn-${idx}`;
            return (
              <div
                key={idx}
                className="t-faq-item"
                data-open={open}
              >
                <div className="t-faq-q">
                  <h3 style={{ margin: 0 }}>
                    <button
                      type="button"
                      id={btnId}
                      aria-expanded={open}
                      aria-controls={panelId}
                      onClick={() => setActiveFaq(open ? null : idx)}
                      style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%', font: 'inherit', fontWeight: 700 }}
                    >
                      {item.q}
                    </button>
                  </h3>
                  <span className="t-faq-plus" style={{ transform: open ? 'rotate(45deg)' : 'rotate(0deg)' }} aria-hidden="true">+</span>
                </div>
                <div className="t-faq-a" id={panelId} role="region" aria-labelledby={btnId} hidden={!open}>
                  <div className="t-faq-a-inner"><p>{item.a}</p></div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Section>
  );
}
