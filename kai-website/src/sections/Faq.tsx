'use client';

import { useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { Badge, Section } from '../components/ui';
import { renderInline } from '../lib/markdown';

const FAQ_ITEMS = [
  { q: 'What is Kai?', a: 'Kai is a desktop terminal for macOS, Linux, and Windows (built with Tauri 2 and Rust). It has tabs, split panes, and a built-in way to run AI coding tools on your own code. MIT licensed.' },
  { q: 'What does it cost? Is there tracking?', a: 'Free. No accounts, no tracking. Your code stays on your machine, and secret files like `.env` are skipped automatically. Connecting Azure DevOps is optional, per folder, and keeps its token in your OS secret store.' },
  { q: 'Can my AI tool read Azure DevOps?', a: 'Yes. In your project folder, run `kai integration azure`. It signs you in, connects the project from the git remote, wires your AI tools and checks that work items, pull requests and builds are readable. Access is read-only. `kai azure active --name <project>` switches the project, and `kai azure remove` disconnects the folder.' },
  { q: 'How do I start?', a: 'Download the installer for your system, open a terminal, and run `kai open` to launch Kai on your project folder. Inside Kai, run `kai claude .` (replace `claude` with your tool\u2019s command).' },
  { q: 'Which AI coding tools work with it?', a: 'Whatever is installed on your machine. Kai detects your tools, fills in their settings for you, and keeps a backup of what was there before.' },
  { q: 'How is it different from a normal terminal?', a: 'It pairs a normal fast terminal (tabs, splits, search) with the AI plumbing: it maps your code, shares that map with the AI tool, and cleans AI credit lines out of your commit messages.' },
  { q: 'Which file do I download?', a: 'macOS: `.dmg` (Apple Silicon M1–M4). Linux: `.deb` for Ubuntu/Debian, or `.AppImage` for anything else. Windows: `.exe` or `.msi` (64-bit).' },
  { q: 'macOS says "kai is damaged"?', a: 'The app isn\u2019t signed yet, so macOS blocks it — the file itself is fine. Eject the image, run `xattr -d com.apple.quarantine` on the `.dmg`, reopen it, drag Kai to Applications, then run `xattr -cr /Applications/Kai.app` and right-click Kai > Open once.' },
];

export function Faq({ showHead = true }: { showHead?: boolean }) {
  const [activeFaq, setActiveFaq] = useState<number | null>(0);
  return (
    <Section id="faq" alt>
      <div className="t-container-narrow" style={{ padding: 0 }}>
        {showHead && (
        <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
          <Badge tone="neutral"><HelpCircle size={14} /> FAQ</Badge>
          <h2 className="t-section-title">Questions</h2>
          <p className="t-section-sub">Straight answers. Click to expand.</p>
        </div>
        )}
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
                  <div className="t-faq-a-inner"><p dangerouslySetInnerHTML={{ __html: renderInline(item.a) }} /></div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Section>
  );
}
