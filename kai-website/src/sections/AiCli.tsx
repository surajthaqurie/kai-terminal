import { Bot, CheckCircle2 } from 'lucide-react';
import { Badge, Section } from '../components/ui';

export function AiCli() {
  return (
    <Section id="ai-cli" alt>
      <div className="t-split">
        <div>
          <Badge tone="purple"><Bot size={14} /> MCP Server & Project Intelligence</Badge>
          <h2 className="t-section-title" style={{ textAlign: 'left' }}>Give your AI assistant real context from your code</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '1.02rem', lineHeight: 1.65, marginBottom: '1rem' }}>
            Kai reads your project locally and answers your AI assistant's questions over a standard bridge called MCP — no uploads, no cloud, no leaked secrets.
          </p>
          <p style={{ color: 'var(--text-tertiary)', fontSize: '0.88rem', lineHeight: 1.6, marginBottom: '1.5rem' }}>
            Vibe-coding? Pick <strong style={{ color: 'var(--text-primary)' }}>one</strong> assistant below to start — Kai wires it with one command.
          </p>
          <ul className="t-check-list">
            <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>Works with 7 assistants</strong> — Claude, Cursor, Codex, Gemini, Copilot, Windsurf, Cline.</span></li>
            <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>Fast &amp; cheap</strong> — answers in under 10ms and uses ~70% fewer tokens than pasting files.</span></li>
            <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>Private by design</strong> — read-only, secrets scrubbed, nothing leaves your machine.</span></li>
            <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>Keeps repos clean</strong> — all indexes live in <code>~/.kai/</code>, never in your git tree.</span></li>
          </ul>
        </div>

        <div className="t-panel t-probe">
          <div className="t-probe-head"><span>$ kai mcp .</span><span className="t-pill">7 MCP tools ready</span></div>
          <pre className="t-code t-code--sm"><code>{`[kai-mcp] Server running on stdio (JSON-RPC 2.0)
✓ kai_project_info     schema version & file stats
✓ kai_search_code      deterministic AST/symbol search
✓ kai_find_symbol      function/class/struct lookup
✓ kai_get_dependencies import graph analysis
✓ kai_get_context      task-budgeted prompt context
✓ kai_refresh_index    safe incremental update
✓ kai_get_lsp_status   local language server health
— read-only workspace confinement · 0 telemetry`}</code></pre>
        </div>
      </div>
    </Section>
  );
}
