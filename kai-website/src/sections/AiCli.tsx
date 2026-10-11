import { Bot, CheckCircle2 } from 'lucide-react';
import { Badge, Section } from '../components/ui';

export function AiCli() {
  return (
    <Section id="ai-cli" alt>
      <div className="t-split">
        <div>
          <Badge tone="purple"><Bot size={14} /> Works with your AI tools</Badge>
          <h2 className="t-section-title" style={{ textAlign: 'left' }}>Let your AI tool understand your code</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '1.02rem', lineHeight: 1.65, marginBottom: '1rem' }}>
            Kai looks at your project on your computer and shares only the needed parts with your AI tool. Nothing is uploaded. Nothing leaves your machine.
          </p>
          <p style={{ color: 'var(--text-tertiary)', fontSize: '0.88rem', lineHeight: 1.6, marginBottom: '1.5rem' }}>
            Just starting? Pick <strong style={{ color: 'var(--text-primary)' }}>one</strong> tool below — Kai connects it with one command.
          </p>
          <ul className="t-check-list">
            <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>Works with 7 tools</strong> — Claude, Cursor, Codex, Gemini, Copilot, Windsurf, Cline.</span></li>
            <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>Fast and low cost</strong> — answers in seconds and uses ~70% less AI cost.</span></li>
            <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>Private</strong> — your code is only read, never changed. Secrets are hidden.</span></li>
            <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>Keeps your project clean</strong> — Kai saves its notes outside your project folder.</span></li>
          </ul>
        </div>

        <div className="t-panel t-probe">
          <div className="t-probe-head"><span>$ kai mcp .</span><span className="t-pill">Ready for AI tools</span></div>
          <pre className="t-code t-code--sm"><code>{`[kai] Ready to help your AI tool
✓ project info      what files you have
✓ search code       find code quickly
✓ find parts        find functions and classes
✓ see links         how files connect
✓ get answers       short, low-cost answers
✓ refresh           update when files change
✓ health check      is everything OK?
— your code never leaves your computer`}</code></pre>
        </div>
      </div>
    </Section>
  );
}
