import { useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { Badge, Section } from '../components/ui';

const FAQ_ITEMS = [
  { q: 'What is Kai?', a: 'A desktop terminal (Tauri 2 + Rust) plus a local CLI that indexes a folder and serves context to AI coding tools over MCP. MIT licensed.' },
  { q: 'What does it cost? Is there tracking?', a: 'MIT, no account. No telemetry in the app. Indexes stay in ~/.kai/ on your machine. .env files, keys and binaries are skipped.' },
  { q: 'How do I start?', a: 'Install the file for your OS, open a repo, run kai code . to index it, then kai agent setup <name> for one AI tool. The Guide shows each command.' },
  { q: 'Which AI tools are covered?', a: 'Claude, Cursor, Codex, Gemini, Copilot, Windsurf and Cline for config generation. The desktop app also lists locally installed CLIs without running them.' },
  { q: 'What are the limits?', a: 'Kai is currently in early preview. kai query output is capped by a token budget (default 4000). Some repos need kai refresh-index after large renames. See Known Limitations in the repo.' },
  { q: 'Which files do I download?', a: 'macOS: .dmg (M1–M4). Linux: .deb for Ubuntu/Debian or .AppImage for other distros. Windows: .exe or .msi (x64). Pick yourself — the site does not auto-decide for you.' },
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
            return (
              <div
                key={idx}
                role="button"
                tabIndex={0}
                aria-expanded={open}
                onClick={() => setActiveFaq(open ? null : idx)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setActiveFaq(open ? null : idx);
                  }
                }}
                className="t-faq-item"
                data-open={open}
              >
                <div className="t-faq-q">
                  <h3>{item.q}</h3>
                  <span className="t-faq-plus" style={{ transform: open ? 'rotate(45deg)' : 'rotate(0deg)' }} aria-hidden="true">+</span>
                </div>
                <div className="t-faq-a" aria-hidden={!open}>
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
