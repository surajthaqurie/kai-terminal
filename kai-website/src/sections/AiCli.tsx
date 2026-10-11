import { Bot, CheckCircle2 } from 'lucide-react';
import { Badge, Section } from '../components/ui';

export function AiCli() {
  return (
    <Section id="ai-cli" alt>
      <div className="t-split">
        <div>
          <Badge tone="purple"><Bot size={14} /> Local context for AI tools</Badge>
          <h2 className="t-section-title" style={{ textAlign: 'left' }}>Context from your repo, on your machine</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '1.02rem', lineHeight: 1.65, marginBottom: '1rem' }}>
            Kai indexes the folder you point it at and serves file snippets over a local MCP bridge.
            No cloud, no account. Indexes live in ~/.kai/.
          </p>
          <p style={{ color: 'var(--text-tertiary)', fontSize: '0.88rem', lineHeight: 1.6, marginBottom: '1.5rem' }}>
            Start with one tool. The config paths differ per tool — Kai writes them for you.
          </p>
          <ul className="t-check-list">
            <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>7 tools covered</strong> — Claude, Cursor, Codex, Gemini, Copilot, Windsurf, Cline.</span></li>
            <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>Local only</strong> — read-only access, .env and keys skipped by default.</span></li>
            <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>Budgeted output</strong> — kai query stays within a token budget (default 4000).</span></li>
            <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>Outside your repo</strong> — nothing is written into your git tree.</span></li>
          </ul>
        </div>

        <div className="t-panel t-probe">
          <div className="t-probe-head"><span>$ kai mcp .</span><span className="t-pill">7 tools, stdio</span></div>
          <pre className="t-code t-code--sm"><code>{`[kai-mcp] listening on stdio
- kai_project_info
- kai_search_code
- kai_find_symbol
- kai_get_dependencies
- kai_get_context
- kai_refresh_index
- kai_get_lsp_status`}</code></pre>
        </div>
      </div>
    </Section>
  );
}
