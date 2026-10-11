import { useState } from 'react';
import { ChevronRight, MousePointerClick } from 'lucide-react';
import { Section, SectionHead } from '../components/ui';
import { CopyBtn } from '../components/CopyBtn';
import { REPO_URL } from '../data/site';

const STEPS: Array<{ n: string; t: string; d: string; what: string }> = [
  { n: '01', t: 'Install Kai', d: 'Download the file for your OS from this page and open it. No account.', what: 'Source build instead? See DEVELOPMENT.md — needs Node 20+ and Rust 1.75+.' },
  { n: '02', t: 'Point Kai at a project', d: 'Open a code folder in Kai, then run: kai code . — the dot means the current folder.', what: 'Kai stores its index in ~/.kai/ outside your repo. Your files are not modified.' },
  { n: '03', t: 'Wire up one AI tool', d: 'Start with one tool, e.g.: kai agent setup claude — then use that tool as normal.', what: 'Each tool keeps its own config file. See Guide for the full command list.' },
];

const SNIPPETS: Record<'run' | 'ai' | 'config', { tab: string; code: string }> = {
  run: {
    tab: '$ project',
    code: '# index the current folder\nkai code .\n\n# ask for context on a task\nkai query "Where is the login code?"\n\n# check state\nkai status\nkai cost',
  },
  ai: {
    tab: '$ AI setup',
    code: '# start the local bridge your AI tool calls\nkai mcp .\n\n# or write the config for one tool\nkai agent setup claude    # ~/.claude.json\nkai agent setup cursor    # .cursor/mcp.json\nkai agent setup codex\nkai agent setup gemini    # ~/.muse/settings.json\nkai agent setup copilot   # .vscode/mcp.json\nkai agent setup windsurf\nkai agent setup cline',
  },
  config: {
    tab: '$ notes',
    code: '# indexes live in ~/.kai/, not in your repo\n# .env*, keys and binaries are skipped\n# run kai unregister <path> to delete an index',
  },
};

export function Quickstart() {
  const [qsTab, setQsTab] = useState<'run' | 'ai' | 'config'>('run');
  return (
    <Section id="quickstart" alt>
      <SectionHead
        title="Get running"
        sub="Install, index one folder, wire up one AI tool."
      />
      <div className="t-guide-callout">
        <MousePointerClick size={18} />
        <span>Follow 01 → 02 → 03 in order. Copy lines exactly — the <code>.</code> in <code>kai code .</code> matters.</span>
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
