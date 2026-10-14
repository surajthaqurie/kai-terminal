import { Bot, CheckCircle2 } from 'lucide-react';
import { Badge, Section } from '../components/ui';

export function AiCli() {
  return (
    <Section id="ai-cli" alt>
      <div className="t-split">
        <div>
          <Badge tone="purple"><Bot size={14} /> Agent Intelligence</Badge>
          <h2 className="t-section-title" style={{ textAlign: 'left' }}>Rich Code Intelligence for External AI Agents</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '1.02rem', lineHeight: 1.65, marginBottom: '1rem' }}>
            Kai indexes your repository locally using Tree-sitter AST parsing and serves ranked semantic context directly over Model Context Protocol (MCP) stdio. Zero accounts, zero cloud dependencies.
          </p>
          <p style={{ color: 'var(--text-tertiary)', fontSize: '0.88rem', lineHeight: 1.6, marginBottom: '1.5rem' }}>
            Kai automatically configures MCP paths for your installed tools, keeping their native configurations backed up and intact.
          </p>
          <ul className="t-check-list">
            <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>10 coding agents supported</strong> — Claude, Cursor, Codex, Gemini, OpenCode, Aider, Windsurf, Cline, Copilot, Antigravity.</span></li>
            <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>Local AST graph engine</strong> — symbol indexing, dependency tracking, and LSP bridging with zero cloud dependencies.</span></li>
            <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>Automatic graph sync</strong> — incremental re-indexing triggered automatically when the agent finishes.</span></li>
            <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>Strict boundary isolation</strong> — indexes reside in ~/.kai/; your source repository files are never touched.</span></li>
          </ul>
        </div>

        <div className="t-panel t-probe">
          <div className="t-probe-head"><span>$ kai claude .</span><span className="t-pill">auto MCP & sync</span></div>
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
