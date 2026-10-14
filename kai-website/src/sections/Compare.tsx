import { Check, Minus } from 'lucide-react';
import { Section, SectionHead } from '../components/ui';
import { COMPARE_ROWS } from '../data/site';

function Cell({ value, highlight }: { value: string; highlight?: boolean }) {
  const none = value.toLowerCase() === 'none';
  const needs = /needs|varies|plugins/i.test(value);
  return (
    <span className="t-compare-cell">
      {highlight ? (
        <Check size={15} aria-hidden="true" />
      ) : none ? (
        <Minus size={15} aria-hidden="true" className="t-compare-dim" />
      ) : needs ? (
        <span aria-hidden="true" className="t-compare-dot">•</span>
      ) : (
        <Check size={15} aria-hidden="true" className="t-compare-dim" />
      )}
      <span>{value}</span>
    </span>
  );
}

export function Compare() {
  return (
    <Section id="compare">
      <SectionHead
        title="Why Kai?"
        sub="A fast terminal that also works with the AI tools you already use."
      />
      <div className="t-compare">
        <div className="t-panel t-table-wrap">
          <table className="t-table t-compare-table">
            <thead>
              <tr><th scope="col"><span className="t-sr">Feature</span></th><th scope="col" className="t-hl">Kai</th><th scope="col">Electron terminals</th><th scope="col">Alacritty</th></tr>
            </thead>
            <tbody>
              {COMPARE_ROWS.map((r) => (
                <tr key={r.label}>
                  <th scope="row">{r.label}</th>
                  <td className="t-hl"><Cell value={r.kai} highlight /></td>
                  <td><Cell value={r.electron} /></td>
                  <td><Cell value={r.alacritty} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="t-micro">Memory with one empty tab. Alacritty needs tmux for tabs and splits.</p>
        </div>
        <div className="t-panel">
          <div className="t-probe-head"><span>How it's built</span><span className="t-pill">Rust core</span></div>
          <ul className="t-check-list" style={{ marginTop: '1.25rem' }}>
            <li><span><strong>Real system terminals</strong> — uses the OS terminal layer directly (ConPTY on Windows), no Electron in between.</span></li>
            <li><span><strong>Splits that don't restart anything</strong> — resizing panes never kills or restarts your running programs.</span></li>
            <li><span><strong>Keeps a map of your code</strong> — tracks functions, classes, and imports, and refreshes the map after each AI session.</span></li>
            <li><span><strong>Tidy git history</strong> — a small git hook removes AI co-author lines from commit messages, and leaves your other hooks alone.</span></li>
          </ul>
          <p className="t-micro" style={{ marginTop: '1.25rem' }}>Same app on macOS, Linux, and Windows. Free and MIT licensed.</p>
        </div>
      </div>
    </Section>
  );
}
