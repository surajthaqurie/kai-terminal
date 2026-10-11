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
      <section className="t-section" id="shortcuts">
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
