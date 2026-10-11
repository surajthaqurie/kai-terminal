import { BookOpen } from 'lucide-react';
import { PageHero } from '../components/PageHero';
import { Quickstart } from '../sections/Quickstart';
import { Container, Reveal } from '../components/ui';
import { SHORTCUTS } from '../data/site';
import { CtaBanner } from '../components/CtaBanner';

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
            <div className="t-panel" style={{ marginBottom: '2.5rem' }}>
              <div className="t-probe-head"><span>$ kai --help</span><span className="t-pill">CLI commands</span></div>
              <ul className="t-keys">
                <li><span>kai code .</span><span className="t-kbd-group"><span className="t-kbd">Index project into ~/.kai/</span></span></li>
                <li><span>kai status</span><span className="t-kbd-group"><span className="t-kbd">Inspect schema version & file health</span></span></li>
                <li><span>kai query "&lt;task&gt;"</span><span className="t-kbd-group"><span className="t-kbd">Deterministic context retrieval</span></span></li>
                <li><span>kai cost</span><span className="t-kbd-group"><span className="t-kbd">Check token budget footprint</span></span></li>
                <li><span>kai mcp .</span><span className="t-kbd-group"><span className="t-kbd">Start stdio MCP server (7 tools)</span></span></li>
                <li><span>kai agent setup &lt;agent&gt;</span><span className="t-kbd-group"><span className="t-kbd">Claude / Cursor / Codex / Gemini / Copilot / Windsurf / Cline</span></span></li>
                <li><span>kai bench .</span><span className="t-kbd-group"><span className="t-kbd">Run token savings & latency benchmark</span></span></li>
                <li><span>kai unregister .</span><span className="t-kbd-group"><span className="t-kbd">Clean up index metadata safely</span></span></li>
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
                    <span>{s.label}</span>
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
