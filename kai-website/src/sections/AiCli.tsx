import { Bot, CheckCircle2 } from 'lucide-react';
import { Badge, Section } from '../components/ui';

export function AiCli() {
  return (
    <Section id="ai-cli" alt>
      <div className="t-split">
        <div>
          <Badge tone="purple"><Bot size={14} /> For AI coding tools</Badge>
          <h2 className="t-section-title" style={{ textAlign: 'left' }}>Your code, ready for AI tools</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '1.02rem', lineHeight: 1.65, marginBottom: '1rem' }}>
            Kai reads your project and hands the AI tool the parts it needs — files, functions, and how they connect. It all happens on your machine.
          </p>
          <p style={{ color: 'var(--text-tertiary)', fontSize: '0.88rem', lineHeight: 1.6, marginBottom: '1.5rem' }}>
            Kai fills in each tool's settings for you, and keeps a backup of what was there before.
          </p>
          <ul className="t-check-list">
            <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>10 tools supported</strong> — Claude Code, Cursor, Codex, Gemini, OpenCode, Aider, Windsurf, Cline, GitHub Copilot, and Antigravity.</span></li>
            <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>Local code intelligence</strong> — builds an AST map of functions, types, and dependencies, and auto-syncs when the agent exits.</span></li>
            <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>Private &amp; self-contained</strong> — index stored in <code>~/.kai/</code>; auto-strips AI co-author trailers in git commits.</span></li>
          </ul>
        </div>

        <div className="t-panel t-probe">
          <div className="t-probe-head"><span>$ kai claude .</span><span className="t-pill">auto MCP &amp; sync</span></div>
          <pre className="t-code t-code--sm"><code>{`[kai] MCP configuration auto-wired for claude.
[kai] Indexing project for Code Mode run...
[kai] Running Code Mode task in "web-app": claude
... [Agent Session Runs Here] ...
[kai] Agent finished (command exited with code 0).
[kai] Graph auto-sync: incremental (changed-files).
Re-indexed 3 modified files in 24ms.`}</code></pre>
        </div>
      </div>
    </Section>
  );
}
