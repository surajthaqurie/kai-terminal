import { Bot, CheckCircle2 } from 'lucide-react';
import { Badge, Section } from '../components/ui';

export function AiCli() {
  return (
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
  );
}
