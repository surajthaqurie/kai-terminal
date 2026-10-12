import { Download, FolderOpen, Bot } from 'lucide-react';
import { Section, SectionHead } from '../components/ui';

const STEPS = [
  {
    icon: Download,
    step: 'Step 1',
    title: 'Install',
    body: 'Download the file for your OS from GitHub Releases and open it. No account.',
    code: 'macOS .dmg / Linux .deb / Windows .exe',
  },
  {
    icon: FolderOpen,
    step: 'Step 2',
    title: 'Index a folder',
    body: 'Open a repo in Kai and run kai code . The index goes to ~/.kai/, your repo stays untouched.',
    code: 'kai code .',
  },
  {
    icon: Bot,
    step: 'Step 3',
    title: 'Use with your AI tool',
    body: 'Run kai agent setup for one tool (Claude, Cursor, Codex, Gemini, Copilot, Windsurf, Cline, opencode or Aider), then work as usual. Run kai agent list to see what is installed.',
    code: 'kai agent setup claude',
  },
];

/* Grounded workflow: Install → Index → Use. No promises, just the commands. */
export function Workflow() {
  return (
    <Section id="how-it-works">
      <SectionHead
        title="How it works"
        sub="Three commands. Everything stays on your machine."
      />
      <div className="t-grid-3">
        {STEPS.map((s) => (
          <div key={s.title} className="t-card" style={{ textAlign: 'left' }}>
            <span className="t-tag">{s.step}</span>
            <div className="t-icon">
              <s.icon size={24} />
            </div>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
            <code
              style={{
                display: 'inline-block',
                marginTop: '0.9rem',
                padding: '0.35rem 0.7rem',
                borderRadius: '8px',
                background: 'var(--btn-secondary-bg)',
                border: '1px solid var(--border-subtle)',
                fontSize: '0.8rem',
              }}
            >
              {s.code}
            </code>
          </div>
        ))}
      </div>
      <p className="t-micro" style={{ textAlign: 'center', marginTop: '1.5rem' }}>
        Full flags and edge cases are in the Guide and README — this is the short version.
      </p>
    </Section>
  );
}
