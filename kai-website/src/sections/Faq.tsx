import { useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { Badge, Section } from '../components/ui';

const FAQ_ITEMS = [
  { q: 'Is Kai free?', a: 'Yes — MIT. Free for personal + commercial, no paywall, reproducible builds on GitHub Actions.' },
  { q: 'Any telemetry?', a: 'No. No analytics, no keystroke logging, strict CSP. Sessions never leave your machine.' },
  { q: 'How does AI work?', a: 'Kai probes PATH for codex / claude / gemini you already installed and launches them in a full pty. Bring your own keys.' },
  { q: 'Why Tauri + Rust?', a: '~30MB idle vs 300MB+ Electron. Native portable-pty streams, faster startup, lower CPU.' },
  { q: 'Which OS builds?', a: 'Windows .exe/.msi · Linux .deb (x64/ARM64) + .AppImage · macOS .dmg (Apple Silicon).' },
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
