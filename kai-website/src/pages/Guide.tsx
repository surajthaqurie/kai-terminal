import { BookOpen, Info } from 'lucide-react';
import { PageHero } from '../components/PageHero';
import { Quickstart } from '../sections/Quickstart';
import { Container, Reveal } from '../components/ui';
import { SHORTCUTS } from '../data/site';
import { CtaBanner } from '../components/CtaBanner';

const CLI_ROWS: Array<[string, string]> = [
  ['kai code .', 'Index the current folder into ~/.kai/'],
  ['kai status', 'Show indexed projects and health'],
  ['kai query "<task>"', 'Print ranked context for a task (budgeted)'],
  ['kai cost', 'Show token usage for the last query'],
  ['kai mcp .', 'Serve the 7 MCP tools over stdio'],
  ['kai agent setup <agent>', 'Install wiring for: claude, cursor, codex, gemini, copilot, windsurf, cline, opencode, aider'],
  ['kai agent setup all', 'Auto-wire every agent installed on this system'],
  ['kai agent list', 'Dynamically detect installed agents + kai wiring state'],
  ['kai bench .', 'Run the local retrieval benchmark'],
  ['kai unregister <path|id>', 'Delete an index (repo untouched)'],
];

/* Guide page: full quickstart + keyboard reference. */
export function GuidePage() {
  return (
    <>
      <PageHero
        badge={<><BookOpen size={14} /> Guide</>}
        title="Setup guide"
        sub="Install the app, index a folder, wire up one AI tool. Commands below."
      />
      <Quickstart />
      <section className="t-section" id="cli-reference">
        <Container narrow>
          <Reveal>
            <h2 className="t-section-title" style={{ fontSize: '1.5rem', marginBottom: '1.25rem' }}>CLI reference</h2>
            <div className="t-guide-callout">
              <Info size={18} />
              <span>Run <code>kai</code> lines inside Kai. <code>.</code> means the current folder.</span>
            </div>
            <div className="t-panel" style={{ marginBottom: '2.5rem' }}>
              <div className="t-probe-head"><span>$ kai --help</span><span className="t-pill">CLI commands</span></div>
              <ul className="t-keys">
                {CLI_ROWS.map(([cmd, desc]) => (
                  <li key={cmd}><span className="t-kbd" style={{ fontSize: '0.78rem' }}>{cmd}</span><span className="t-keys-desc">{desc}</span></li>
                ))}
              </ul>
              <p className="t-micro">Indexes live in ~/.kai/. Run kai --help for flags.</p>
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
              <p className="t-micro">Shortcuts show Ctrl — use Cmd on macOS. Remappable in Settings.</p>
            </div>
          </Reveal>
        </Container>
      </section>
      <CtaBanner />
    </>
  );
}
