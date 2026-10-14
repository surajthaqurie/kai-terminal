import { Section, SectionHead } from '../components/ui';
import { COMPARE_ROWS } from '../data/site';

export function Compare() {
  return (
    <Section id="compare">
      <SectionHead
        title="Kai vs other options"
        sub="Measured on the maintainer's machine. Your numbers will differ."
      />
      <div className="t-compare">
        <div className="t-panel t-table-wrap">
          <table className="t-table">
            <thead>
              <tr><th scope="col"><span className="t-sr">Feature</span></th><th scope="col" className="t-hl">kai</th><th scope="col">Electron apps</th><th scope="col">Alacritty</th></tr>
            </thead>
            <tbody>
              {COMPARE_ROWS.map((r) => (
                <tr key={r.label}>
                  <th scope="row">{r.label}</th>
                  <td className="t-hl">{r.kai}</td>
                  <td>{r.electron}</td>
                  <td>{r.alacritty}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="t-micro">Typical idle figures on the author's machine. Alacritty tabs/splits need tmux.</p>
        </div>
        <div className="t-panel">
          <div className="t-probe-head"><span>Architecture Highlights</span><span className="t-pill">Native Core</span></div>
          <ul className="t-check-list" style={{ marginTop: '1.25rem' }}>
            <li><span><strong>Native POSIX & ConPTY</strong> — High-frequency ANSI streaming with direct OS pseudoterminal allocation and zero Electron bridge overhead.</span></li>
            <li><span><strong>Zero-Remount Grid Splits</strong> — Layout adjustments and pane resizes preserve live shell processes and scrollback buffers without unmounting.</span></li>
            <li><span><strong>Tree-sitter Symbol Graph</strong> — Incremental AST parsing extracts function, class, and dependency relationships with automatic post-session sync.</span></li>
            <li><span><strong>Automated Git Hygiene</strong> — Self-contained commit-msg hook automatically strips AI co-author trailers while safely chaining existing hooks.</span></li>
          </ul>
          <p className="t-micro" style={{ marginTop: '1.25rem' }}>Engineered in Rust and TypeScript. Verified cross-platform native builds.</p>
        </div>
      </div>
    </Section>
  );
}
