import { useState } from 'react';
import { ChevronRight, MousePointerClick } from 'lucide-react';
import { Section, SectionHead } from '../components/ui';
import { CopyBtn } from '../components/CopyBtn';
import { REPO_URL } from '../data/site';

const STEPS: Array<{ n: string; t: string; d: string; what: string }> = [
  { n: '01', t: 'Install Kai', d: 'Download the installer above for your OS — or clone and run from source.', what: 'What you get: a native app, ~30MB idle, no account needed.' },
  { n: '02', t: 'Open your project folder', d: 'In Kai, open any code folder, then run kai code . — the dot just means “this folder”.', what: 'What it does: builds a private local index in ~/.kai/ — your git files are never touched.' },
  { n: '03', t: 'Connect your AI assistant', d: 'One command wires Claude, Cursor, Codex, Gemini, Copilot, Windsurf or Cline — pick just one to start.', what: 'Try: kai agent setup claude — then ask your assistant about your code.' },
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
        sub="Install, open a project, connect one AI assistant. No account, no config wizard."
      />
      <div className="t-guide-callout">
        <MousePointerClick size={18} />
        <span><strong>New to terminals or vibe-coding?</strong> Follow steps 01 → 02 → 03 in order. Copy-paste each <code>$</code> command as-is — the dots and dashes matter.</span>
      </div>
      <div className="t-split">
        <div className="t-steps">
          {STEPS.map((s) => (
            <div key={s.n} className="t-step">
              <span className="t-step-n">{s.n}</span>
              <div><b>{s.t}</b><p>{s.d}</p><span className="t-step-what">{s.what}</span></div>
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
