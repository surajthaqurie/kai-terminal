import { Bot, CheckCircle2 } from 'lucide-react';
import { Badge, Section } from '../components/ui';

export function AiCli() {
  return (
    <Section id="ai-cli" alt>
      <div className="t-split">
        <div>
          <Badge tone="purple"><Bot size={14} /> MCP Server & Project Intelligence</Badge>
          <h2 className="t-section-title" style={{ textAlign: 'left' }}>Supercharge Claude, Cursor, Codex, Gemini, Copilot &amp; more with local context</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '1.02rem', lineHeight: 1.65, marginBottom: '1.5rem' }}>
            Kai is both a high-performance terminal and a local Model Context Protocol (MCP) server. External coding agents connect over stdio to query AST symbols, dependency graphs, and task-budgeted context — without polluting your repo or leaking secrets.
          </p>
          <ul className="t-check-list">
            <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>Standard stdio MCP server</strong> — 7 tools for Claude, Cursor, Codex, Gemini, Copilot, Windsurf, Cline.</span></li>
            <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>Sub-10ms retrieval &amp; ~70% token savings</strong> — deterministic ranker beats raw dumps.</span></li>
            <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>Audited read-only security</strong> — stream-bounded requests (10 MB), path confinement, live staleness checks, secret scrubbing.</span></li>
            <li><CheckCircle2 size={18} color="var(--accent-purple-fg)" /><span><strong>Isolated storage</strong> — indexes stored strictly in <code>~/.kai/</code>, keeping git trees clean.</span></li>
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
