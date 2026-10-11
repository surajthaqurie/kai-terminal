import { BookOpen, Info } from 'lucide-react';
import { PageHero } from '../components/PageHero';
import { Quickstart } from '../sections/Quickstart';
import { Container, Reveal } from '../components/ui';
import { SHORTCUTS } from '../data/site';
import { CtaBanner } from '../components/CtaBanner';

const CLI_ROWS: Array<[string, string]> = [
  ['kai code .', 'Index this folder into ~/.kai/ — the dot means “current folder”'],
  ['kai status', 'Check index health, file count and schema version'],
  ['kai query "<task>"', 'Ask for relevant code context, ranked to save tokens'],
  ['kai cost', 'See how many tokens the last query used'],
  ['kai mcp .', 'Start the local AI bridge (7 tools) for assistants to call'],
  ['kai agent setup <agent>', 'One-time wiring: claude, cursor, codex, gemini, copilot, windsurf or cline'],
  ['kai bench .', 'Measure speed + token savings on this folder'],
  ['kai unregister <path|id>', 'Remove an index safely when you are done'],
];

/* Guide page: full quickstart + keyboard reference. */
export function GuidePage() {
  return (
    <>
      <PageHero
        badge={<><BookOpen size={14} /> Guide · 30 seconds</>}
        title="Get started with kai"
        sub="Install, verify the engine, plug in your AI CLI. No account, no config wizard."
      />
      <Quickstart />
      <section className="t-section" id="cli-reference">
        <Container narrow>
          <Reveal>
            <h2 className="t-section-title" style={{ fontSize: '1.5rem', marginBottom: '1.25rem' }}>Project Intelligence & MCP Reference</h2>
            <div className="t-guide-callout">
              <Info size={18} />
              <span>Copy one line at a time. Lines starting with <code>kai</code> run inside the Kai terminal — <code>.</code> always means “the folder I am in”.</span>
            </div>
            <div className="t-panel" style={{ marginBottom: '2.5rem' }}>
              <div className="t-probe-head"><span>$ kai --help</span><span className="t-pill">CLI commands</span></div>
              <ul className="t-keys">
                {CLI_ROWS.map(([cmd, desc]) => (
                  <li key={cmd}><span className="t-kbd" style={{ fontSize: '0.78rem' }}>{cmd}</span><span className="t-keys-desc">{desc}</span></li>
                ))}
              </ul>
              <p className="t-micro">All indexes live in ~/.kai/ — your source repository is kept strictly read-only and unpolluted.</p>
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
              <p className="t-micro">Ctrl shown · macOS uses Cmd · change any binding in Settings.</p>
            </div>
          </Reveal>
        </Container>
      </section>
      <CtaBanner />
    </>
  );
}
