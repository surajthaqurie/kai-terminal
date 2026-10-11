import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Section, SectionHead } from '../components/ui';
import { CopyBtn } from '../components/CopyBtn';
import { REPO_URL } from '../data/site';

const STEPS: Array<[string, string, string]> = [
  ['01', 'Install or Clone', 'Get the native binary for your OS or run directly with npm / cargo.'],
  ['02', 'Index Your Project', 'Run kai code . to parse AST symbols, imports, and dependencies in ~/.kai/.'],
  ['03', 'Connect AI Agents', 'Run kai mcp . or kai agent setup <claude|cursor|codex|gemini|copilot|windsurf|cline> for instant zero-config integration.'],
];

const SNIPPETS: Record<'run' | 'ai' | 'config', { tab: string; code: string }> = {
  run: {
    tab: '$ project-intelligence',
    code: '# 1 · index any codebase into ~/.kai/ without touching git\nkai code .\n\n# 2 · query ranked context within strict token budgets\nkai query "Explain PtyManager state machine"\n\n# 3 · check indexing health, symbols, and token footprint\nkai status\nkai cost',
  },
  ai: {
    tab: '$ mcp-agent-setup',
    code: '# Run Kai MCP server directly over stdio\nkai mcp .\n\n# Or configure your favorite AI coding agent in one command:\nkai agent setup claude    # configures ~/.claude.json\nkai agent setup cursor    # configures cursor mcp settings\nkai agent setup codex     # OpenAI Codex stdio configuration\nkai agent setup gemini    # configures ~/.muse/settings.json\nkai agent setup copilot   # configures .vscode/mcp.json\nkai agent setup windsurf  # configures windsurf mcp_config.json\nkai agent setup cline     # configures cline_mcp_settings.json',
  },
  config: {
    tab: '$ terminal-pty',
    code: '# Native PTY with ConPTY on Windows, POSIX pty on Linux/macOS\n# GPU accelerated rendering with xterm.js at 60fps\n# Isolated tabs and processes · zero telemetry, 100% private',
  },
};

export function Quickstart() {
  const [qsTab, setQsTab] = useState<'run' | 'ai' | 'config'>('run');
  return (
    <Section id="quickstart" alt>
      <SectionHead
        title="Up and running in 30 seconds"
        sub="Install, verify, plug in your AI CLI. No account, no config wizard."
      />
      <div className="t-split">
        <div className="t-steps">
          {STEPS.map(([n, t, d]) => (
            <div key={n} className="t-step">
              <span className="t-step-n">{n}</span>
              <div><b>{t}</b><p>{d}</p></div>
            </div>
          ))}
          <a className="t-link" href={`${REPO_URL}/blob/main/DEVELOPMENT.md`}>Read DEVELOPMENT.md <ChevronRight size={15} /></a>
        </div>
        <div className="t-panel t-code-panel">
          <div className="t-install-tabs" role="tablist" aria-label="Quickstart snippets">
            {(Object.keys(SNIPPETS) as Array<'run' | 'ai' | 'config'>).map((k) => (
              <button key={k} role="tab" aria-selected={qsTab === k} data-active={qsTab === k} className="t-install-tab" onClick={() => setQsTab(k)}>
                {SNIPPETS[k].tab}
              </button>
            ))}
            <span style={{ flex: 1 }} />
            <CopyBtn text={SNIPPETS[qsTab].code} />
          </div>
          <pre className="t-code"><code>{SNIPPETS[qsTab].code}</code></pre>
        </div>
      </div>
    </Section>
  );
}
