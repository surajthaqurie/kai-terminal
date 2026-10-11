import { useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { Badge, Section } from '../components/ui';

const FAQ_ITEMS = [
  { q: 'Is Kai free?', a: 'Yes — MIT. Free for personal + commercial use, no paywall, reproducible builds on GitHub Actions.' },
  { q: 'Any telemetry or secret logging?', a: 'Zero telemetry. No cloud proxy, no keystroke tracking, strict workspace boundary isolation. Sensitive keys and tokens (.env*, id_rsa*, PATs) are automatically scrubbed from indexes.' },
  { q: 'How does Project Intelligence & MCP work?', a: 'Kai indexes your repository locally (AST symbols, dependencies, and rules) and stores metadata safely in ~/.kai/. External AI tools (Claude Code, Cursor, Codex) connect via standard stdio MCP to get relevant, token-budgeted context without dumping whole directories.' },
  { q: 'How fast is retrieval and how many tokens does it save?', a: 'Local context retrieval runs in under 10ms (typically 0.8ms - 3.2ms). By extracting only relevant AST symbols and dependencies, it achieves ~70% token reductions compared to naive file dumps.' },
  { q: 'Why Tauri + Rust?', a: '~30MB idle vs 300MB+ Electron. Native portable-pty streams, faster startup, and minimal memory overhead on Windows, Linux, and macOS.' },
  { q: 'Which OS builds are supported?', a: 'Windows .exe/.msi · Linux .deb (x64/ARM64) + .AppImage · macOS .dmg (Apple Silicon).' },
];

export function Faq() {
  const [activeFaq, setActiveFaq] = useState<number | null>(0);
  return (
    <Section id="faq" alt>
      <div className="t-container-narrow" style={{ padding: 0 }}>
        <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
          <Badge tone="neutral"><HelpCircle size={14} /> FAQ</Badge>
          <h2 className="t-section-title">Frequently asked questions</h2>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.9rem' }}>
          {FAQ_ITEMS.map((item, idx) => (
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
  );
}
