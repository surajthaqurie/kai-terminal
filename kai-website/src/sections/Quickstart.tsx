import { useState } from 'react';
import { ChevronRight, MousePointerClick } from 'lucide-react';
import { Section, SectionHead } from '../components/ui';
import { CopyBtn } from '../components/CopyBtn';
import { REPO_URL } from '../data/site';

const STEPS: Array<{ n: string; t: string; d: string; what: string }> = [
  { n: '01', t: 'Install Kai', d: 'Download Kai for your system above. Open it like any normal app.', what: 'You get: a fast app. No account. Takes 30 seconds.' },
  { n: '02', t: 'Open your project', d: 'Open your code folder in Kai, then type: kai code . — the dot means “this folder”.', what: 'What happens: Kai makes a private list of your files. Your code is not changed.' },
  { n: '03', t: 'Connect your AI tool', d: 'Pick one AI tool to start. Type: kai agent setup claude — then ask questions about your code.', what: 'Try it: ask your AI “Where is the login code?” and it will find it fast.' },
];

const SNIPPETS: Record<'run' | 'ai' | 'config', { tab: string; code: string }> = {
  run: {
    tab: '$ my project',
    code: '# 1 · Tell Kai which folder to remember (dot = this folder)\nkai code .\n\n# 2 · Ask a question about your code\nkai query "Where is the login code?"\n\n# 3 · Check health and cost\nkai status\nkai cost',
  },
  ai: {
    tab: '$ connect AI',
    code: '# Start the helper your AI tool talks to\nkai mcp .\n\n# Or connect your favorite AI tool with one line:\nkai agent setup claude    # for Claude\nkai agent setup cursor    # for Cursor\nkai agent setup codex     # for Codex\nkai agent setup gemini    # for Gemini\nkai agent setup copilot   # for VS Code Copilot\nkai agent setup windsurf  # for Windsurf\nkai agent setup cline     # for Cline',
  },
  config: {
    tab: '$ why Kai?',
    code: '# Fast on Windows, Linux and Mac\n# Clear text, smooth scrolling\n# Separate safe tabs · nothing is tracked',
  },
};

export function Quickstart() {
  const [qsTab, setQsTab] = useState<'run' | 'ai' | 'config'>('run');
  return (
    <Section id="quickstart" alt>
      <SectionHead
        title="Ready in 3 simple steps"
        sub="Install, open a project, connect your AI tool. That is all."
      />
      <div className="t-guide-callout">
        <MousePointerClick size={18} />
        <span><strong>New to terminals?</strong> Just follow steps 01 → 02 → 03. Copy each line exactly as shown — dots and dashes matter.</span>
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
