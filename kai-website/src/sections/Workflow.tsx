import { Download, FolderOpen, Bot } from 'lucide-react';
import { Section, SectionHead } from '../components/ui';
import { Link } from '../router';

const STEPS = [
  {
    icon: Download,
    step: 'Step 1',
    title: 'Install Kai',
    body: 'Download the installer for your OS (macOS .dmg, Linux .deb/.AppImage, or Windows .exe/.msi) from GitHub Releases. Free & MIT licensed.',
    code: 'macOS .dmg / Linux .deb / Windows .exe',
  },
  {
    icon: FolderOpen,
    step: 'Step 2',
    title: 'Open Kai Terminal',
    body: 'From any shell, run kai open to launch the Kai Terminal desktop app. You can optionally specify a project folder or just run kai open in your current directory.',
    code: 'kai open',
  },
  {
    icon: Bot,
    step: 'Step 3',
    title: 'Launch any AI agent',
    body: 'Inside Kai Terminal, launch your tool with kai claude . (Claude Code shown — replace claude with your tool\u2019s command). Kai auto-wires MCP, runs the agent, strips co-authors, and auto-syncs the code graph on exit.',
    code: 'kai claude .',
  },
];

/* Grounded workflow: Install → Index → Use. No promises, just the commands. */
export function Workflow() {
  return (
    <Section id="how-it-works">
      <SectionHead
        title="How it works"
        sub="Three steps, all on your machine."
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
        Every command is listed in the <Link to="/commands" style={{ color: 'var(--accent-cyan-fg)' }}>User Manual</Link>.
      </p>
    </Section>
  );
}
