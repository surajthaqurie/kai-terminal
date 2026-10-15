import { useState } from 'react';
import { ChevronRight, MousePointerClick } from 'lucide-react';
import { Section, SectionHead } from '../components/ui';
import { CopyBtn } from '../components/CopyBtn';
import { REPO_URL } from '../data/site';

const STEPS: Array<{ n: string; t: string; d: string; what: string }> = [
  { n: '01', t: 'Install Kai', d: 'Download the installer for your OS from GitHub Releases. No account or cloud sign-up.', what: 'Source build instead? See DEVELOPMENT.md — requires Node 20+ and Rust 1.75+.' },
  { n: '02', t: 'Launch Kai Terminal', d: 'From any shell, run: kai open to launch the Kai Terminal desktop app.', what: 'kai open launches the Kai Terminal application itself (optional path defaults to current directory).' },
  { n: '03', t: 'Run your AI coding tool', d: 'Inside Kai Terminal, run your tool\u2019s command (Claude Code shown): kai claude .', what: 'Kai connects the tool, runs it, and updates the code map on exit.' },
];

const SNIPPETS: Record<'run' | 'ai' | 'config', { tab: string; code: string }> = {
  run: {
    tab: '$ workflow',
    code: '# 1. Launch Kai Terminal app (from any shell)\nkai open\n# Or open Kai Terminal for a specific project folder:\n# kai open /path/to/project\n\n# 2. Inside Kai Terminal, launch your AI tool (Claude Code shown)\nkai claude .\n\n# Kai connects the tool and updates the code map on exit.\n\n# 3. Check health\nkai health',
  },
  ai: {
    tab: '$ AI agents',
    code: '# Launch your tool directly inside Kai Terminal (Claude Code shown):\nkai claude .\n\n# Check installed tools and connection state\nkai list -a\n\n# Connect every installed tool at once\nkai setup all',
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
