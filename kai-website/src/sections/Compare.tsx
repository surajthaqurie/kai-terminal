import { Section, SectionHead } from '../components/ui';
import { COMPARE_ROWS, SHORTCUTS } from '../data/site';

export function Compare() {
  return (
    <Section id="compare">
      <SectionHead
        title="How Kai compares"
        sub="Footprint, workflow, and privacy at a glance."
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
      </div>
    </Section>
  );
}
