import { BookOpen, Info } from 'lucide-react';
import { PageHero } from '../components/PageHero';
import { Quickstart } from '../sections/Quickstart';
import { Container, Reveal } from '../components/ui';
import { SHORTCUTS } from '../data/site';
import { CtaBanner } from '../components/CtaBanner';

const CLI_ROWS: Array<[string, string]> = [
  ['kai code .', 'Remember this folder (dot = here)'],
  ['kai status', 'See if everything is healthy'],
  ['kai query "<task>"', 'Ask a question, get a short answer'],
  ['kai cost', 'See how much AI cost you used'],
  ['kai mcp .', 'Start the helper for AI tools'],
  ['kai agent setup <agent>', 'Connect one tool: claude, cursor, codex, gemini, copilot, windsurf or cline'],
  ['kai bench .', 'Test speed on this folder'],
  ['kai unregister <path|id>', 'Forget a folder when you are done'],
];

/* Guide page: full quickstart + keyboard reference. */
export function GuidePage() {
  return (
    <>
      <PageHero
        badge={<><BookOpen size={14} /> Guide · Easy start</>}
        title="Learn Kai in 30 seconds"
        sub="Install, open a project, ask your AI tool. No account. No stress."
      />
      <Quickstart />
      <section className="t-section" id="cli-reference">
        <Container narrow>
          <Reveal>
            <h2 className="t-section-title" style={{ fontSize: '1.5rem', marginBottom: '1.25rem' }}>All commands in one place</h2>
            <div className="t-guide-callout">
              <Info size={18} />
              <span>Copy one line at a time. Lines that start with <code>kai</code> run inside Kai — <code>.</code> always means “this folder”.</span>
            </div>
            <div className="t-panel" style={{ marginBottom: '2.5rem' }}>
              <div className="t-probe-head"><span>$ kai --help</span><span className="t-pill">CLI commands</span></div>
              <ul className="t-keys">
                {CLI_ROWS.map(([cmd, desc]) => (
                  <li key={cmd}><span className="t-kbd" style={{ fontSize: '0.78rem' }}>{cmd}</span><span className="t-keys-desc">{desc}</span></li>
                ))}
              </ul>
              <p className="t-micro">Kai saves its notes outside your project, so your files stay clean and safe.</p>
            </div>
          </Reveal>
        </Container>
      </section>
      <section className="t-section t-section-alt" id="shortcuts">
        <Container narrow>
          <Reveal>
            <div className="t-panel">
              <div className="t-probe-head"><span>$ keyboard-first</span><span className="t-pill">remappable</span></div>
              <ul className="t-keys">
                {SHORTCUTS.map((s) => (
                  <li key={s.label}>
                    <span className="t-keys-label">{s.label}</span>
                    <span className="t-kbd-group">
                      {s.keys.map((k) => <kbd key={k} className="t-kbd">{k}</kbd>)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="t-micro">Ctrl is shown · On Mac use Cmd · You can change keys in Settings.</p>
            </div>
          </Reveal>
        </Container>
      </section>
      <CtaBanner />
    </>
  );
}
