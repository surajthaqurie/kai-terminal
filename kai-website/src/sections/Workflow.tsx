import { Download, FolderOpen, Bot } from 'lucide-react';
import { Section, SectionHead } from '../components/ui';

const STEPS = [
  {
    icon: Download,
    step: 'Step 1',
    title: 'Install Kai',
    body: 'Download Kai for your system. Open it. Done in 30 seconds. No account needed.',
    code: 'Download → Open → Done',
  },
  {
    icon: FolderOpen,
    step: 'Step 2',
    title: 'Add your project',
    body: 'Open your code folder in Kai and type kai code . The dot means “this folder”. Kai learns your files — safely, on your computer.',
    code: 'kai code .',
  },
  {
    icon: Bot,
    step: 'Step 3',
    title: 'Ask with AI',
    body: 'Connect one AI tool, then ask questions in plain words. Example: “Where is the login code?” You get a short, correct answer.',
    code: 'kai agent setup claude',
  },
];

/* Simple professional workflow: Install → Add project → Ask with AI.
   Uses plain words so beginners and pros both understand. */
export function Workflow() {
  return (
    <Section id="how-it-works">
      <SectionHead
        title="How it works"
        sub="Three simple steps. No tech skills needed."
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
        That is the full workflow. Every page and guide on this site follows the same 3 steps.
      </p>
    </Section>
  );
}
