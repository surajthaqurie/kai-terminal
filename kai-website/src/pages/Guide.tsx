import { BookOpen, FileText, Info, ArrowRight } from 'lucide-react';
import { PageHero } from '../components/PageHero';
import { Quickstart } from '../sections/Quickstart';
import { Container, Reveal } from '../components/ui';
import { SHORTCUTS } from '../data/site';
import { CtaBanner } from '../components/CtaBanner';
import { Link } from '../router';

const CLI_ROWS: Array<[string, string]> = [
  ['kai open [path]', 'Open or focus Kai Terminal for a project directory (run from any shell)'],
  ['kai close', 'Close running Kai Terminal desktop application instances'],
  ['kai <agent> [path]', 'Launch AI agent with auto MCP wiring, Code Mode, and graph auto-sync'],
  ['kai list -a', 'List installed AI coding agents and their Kai MCP wiring status'],
  ['kai list -i', 'List registered project indexes, status, symbol counts, and freshness'],
  ['kai setup <agent|all>', 'Auto-wire Kai MCP server directly into agent configurations'],
  ['kai remove -i [path]', 'Safely delete project AST index (source code is never touched)'],
  ['kai remove -a <agent>', 'Remove Kai MCP configuration from the specified agent'],
  ['kai graph init [path]', 'Initialize AST symbol index and dependency graph for project'],
  ['kai graph update [path]', 'Force rebuild and update of the AST symbol database'],
  ['kai status [path]', 'Display project health, freshness, commit hook, and LSP state'],
  ['kai stop', 'Clear Code Mode active project state and return to plain terminal'],
  ['kai doctor', 'Audit desktop binary, install directories, and desktop drawer entries'],
  ['kai lsp', 'Probe local Language Server Protocol servers (TS, Python, Rust, Go, etc.)'],
  ['kai metrics', 'Display local privacy-safe performance latency metrics and heuristics'],
];

/* Guide page: quickstart + command cheatsheet + keyboard reference. */
export function GuidePage() {
  return (
    <>
      <PageHero
        badge={<><BookOpen size={14} /> Guide</>}
        title="Setup guide"
        sub="Install the desktop app, open your project, and launch any external AI coding agent."
      />

      <section className="t-section" style={{ paddingBottom: '1rem', paddingTop: '1rem' }}>
        <Container narrow>
          <div className="t-guide-callout" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: '0.9rem', alignItems: 'center' }}>
              <FileText size={20} style={{ color: 'var(--accent-cyan-fg)' }} />
              <div>
                <strong>Need the complete reference manual?</strong>
                <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--text-secondary)' }}>
                  Read our full User Manual covering environment boundaries, options, sample outputs, and cheatsheet.
                </p>
              </div>
            </div>
            <Link to="/manual" className="t-btn t-btn--secondary t-btn--sm" style={{ marginTop: '0.5rem' }}>
              Open User Manual <ArrowRight size={14} />
            </Link>
          </div>
        </Container>
      </section>

      <Quickstart />

      <section className="t-section" id="cli-reference">
        <Container narrow>
          <Reveal>
            <h2 className="t-section-title" style={{ fontSize: '1.5rem', marginBottom: '1.25rem' }}>Core CLI reference</h2>
            <div className="t-guide-callout">
              <Info size={18} />
              <span>
                Use <code>kai open [path]</code> from your external shell to launch Kai Terminal. Inside Kai Terminal tabs, run agent workflows (e.g. <code>kai claude .</code>).
              </span>
            </div>
            <div className="t-panel" style={{ marginBottom: '2.5rem' }}>
              <div className="t-probe-head"><span>$ kai --help</span><span className="t-pill">CLI commands</span></div>
              <ul className="t-keys">
                {CLI_ROWS.map(([cmd, desc]) => (
                  <li key={cmd}>
                    <span className="t-kbd" style={{ fontSize: '0.78rem' }}>{cmd}</span>
                    <span className="t-keys-desc">{desc}</span>
                  </li>
                ))}
              </ul>
              <div style={{ marginTop: '1.25rem', paddingTop: '1rem', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
                <p className="t-micro" style={{ margin: 0 }}>Data stored in ~/.kai/. Repositories are never modified.</p>
                <Link to="/manual" className="t-link" style={{ fontSize: '0.85rem' }}>View complete manual & options →</Link>
              </div>
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
