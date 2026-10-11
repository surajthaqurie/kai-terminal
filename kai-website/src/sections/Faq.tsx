import { useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { Badge, Section } from '../components/ui';

const FAQ_ITEMS = [
  { q: 'Is Kai free?', a: 'Yes. Kai is free for personal and work use. No hidden fees, no locked features.' },
  { q: 'Does Kai track me or upload my code?', a: 'No. Everything stays on your computer. Kai does not track you, does not upload code, and hides passwords and secret keys automatically.' },
  { q: 'How does Kai help my AI tool?', a: 'Kai makes a private map of your project on your computer. When your AI tool (like Claude or Cursor) has a question, Kai gives it just the small part of code it needs. This is faster and cheaper.' },
  { q: 'Which AI tools work with Kai?', a: 'Claude, Cursor, Codex, Gemini, Copilot, Windsurf and Cline. You only need one command to connect: for example, kai agent setup claude.' },
  { q: 'Is it fast? Does it save money?', a: 'Yes. Answers come in less than 10 milliseconds. Because Kai shares only the needed code, you use about 70% less AI tokens — so lower cost.' },
  { q: 'Why is Kai so light?', a: 'Kai is built with Rust and Tauri, not Electron. It uses about 30MB of memory instead of 300MB+. It starts fast and runs well on Windows, Linux and Mac.' },
  { q: 'Which systems can I install it on?', a: 'Mac (M1 to M4), Linux (.deb and .AppImage), and Windows 10 and 11 (.exe and .msi). One simple download for each.' },
];

export function Faq() {
  const [activeFaq, setActiveFaq] = useState<number | null>(0);
  return (
    <Section id="faq" alt>
      <div className="t-container-narrow" style={{ padding: 0 }}>
        <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
          <Badge tone="neutral"><HelpCircle size={14} /> FAQ</Badge>
          <h2 className="t-section-title">Common questions</h2>
          <p className="t-section-sub">Simple answers. Click a question to see more.</p>
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
