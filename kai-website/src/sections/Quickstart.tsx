import { useState } from 'react';
import { ChevronRight, MousePointerClick } from 'lucide-react';
import { Section, SectionHead } from '../components/ui';
import { CopyBtn } from '../components/CopyBtn';
import { REPO_URL } from '../data/site';

const STEPS: Array<{ n: string; t: string; d: string; what: string }> = [
  { n: '01', t: 'Install Kai', d: 'Download the installer for your OS from GitHub Releases. No account or cloud sign-up.', what: 'Source build instead? See DEVELOPMENT.md — requires Node 20+ and Rust 1.75+.' },
  { n: '02', t: 'Open Kai for your project', d: 'From any shell, run: kai open [path] to focus Kai Terminal on your repository.', what: 'Kai initializes Code Mode and registers ~/.kai/ metadata without modifying your git repo.' },
  { n: '03', t: 'Run your AI coding agent', d: 'Inside Kai Terminal, run: kai claude . (or cursor, aider, opencode, gemini, agy).', what: 'Kai auto-wires MCP, runs the agent, strips co-author trailers, and auto-syncs the AST graph on exit.' },
];

const SNIPPETS: Record<'run' | 'ai' | 'config', { tab: string; code: string }> = {
  run: {
    tab: '$ workflow',
    code: '# 1. Open your project in Kai Terminal (from any shell)\nkai open .\n\n# 2. Inside Kai Terminal, launch your favorite AI agent\nkai claude .\n\n# Kai auto-wires MCP, enters Code Mode, strips co-authors,\n# and auto-syncs the AST symbol graph upon agent exit.\n\n# 3. Check project and LSP bridge health\nkai status',
  },
  ai: {
    tab: '$ AI agents',
    code: '# Launch agents directly inside Kai Terminal:\nkai claude .       # Claude Code\nkai cursor .       # Cursor IDE\nkai aider .        # Aider CLI\nkai opencode .     # OpenCode\nkai gemini .       # Gemini CLI\nkai agy .          # Antigravity CLI\n\n# Detect installed agents and Kai MCP status\nkai list -a\n\n# Wire Kai MCP across all detected agents\nkai setup all',
  },
  config: {
    tab: '$ management',
    code: '# List indexed projects & symbol counts\nkai list -i\n\n# Probe local Language Server Protocol (LSP) servers\nkai lsp\n\n# Audit environment, desktop binary, and PATH\nkai doctor\n\n# Safely remove project index (source code is never touched)\nkai remove -i .',
  },
};

export function Quickstart() {
  const [qsTab, setQsTab] = useState<'run' | 'ai' | 'config'>('run');
  return (
    <Section id="quickstart" alt>
      <SectionHead
        title="Get running"
        sub="Install, open your project with kai open, and launch any external AI agent."
      />
      <div className="t-guide-callout">
        <MousePointerClick size={18} />
        <span>Follow 01 → 02 → 03 in order. Use <code>kai open [path]</code> in any shell, then run agent commands inside Kai.</span>
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
