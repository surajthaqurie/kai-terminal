import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Section, SectionHead } from '../components/ui';
import { CopyBtn } from '../components/CopyBtn';
import { REPO_URL } from '../data/site';

const STEPS: Array<[string, string, string]> = [
  ['01', 'Install', 'Get the file for your OS above. One download, no setup wizard.'],
  ['02', 'Open and verify', 'Launch Kai, then run kai --status to check the engine.'],
  ['03', 'Bring your AI', 'Install Codex, Claude, or Gemini CLI. Kai finds them on PATH — nothing to paste, no keys to hand over.'],
];

const SNIPPETS: Record<'run' | 'ai' | 'config', { tab: string; code: string }> = {
  run: {
    tab: '$ quickstart',
    code: '# 1 · open Kai, then check it is healthy\nkai --status\n\n# 2 · see everything it can do\nkai --help',
  },
  ai: {
    tab: '$ ai',
    code: '# Kai uses AI tools you already installed — nothing bundled\ncodex --help      # OpenAI Codex CLI\nclaude --help     # Claude Code\nGemini --help     # Gemini CLI',
  },
  config: {
    tab: '$ config',
    code: '# no config needed — the defaults are sane\n# theme follows your OS · font is Fira Code\n# shell: $SHELL on Linux/macOS, ConPTY on Windows',
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
