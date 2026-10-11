import { Download } from 'lucide-react';
import { PageHero } from '../components/PageHero';
import { InstallBar } from '../components/InstallBar';
import { Downloads } from '../sections/Downloads';
import { Container, Reveal } from '../components/ui';
import type { LatestRelease } from '../hooks/useRepo';

/* Dedicated install page: auto-fed by useLatestRelease (GitHub API).
   Shows live assets when a release exists, source fallback otherwise. */
export function DownloadPage({ rel }: { rel: LatestRelease }) {
  return (
    <>
      <PageHero
        badge={<><Download size={14} /> {rel.tag} · Free · For all systems</>}
        title="Download Kai"
        sub={`${rel.tag} · Pick your system and install in 30 seconds.`}
      >
        <InstallBar short={rel.short} />
      </PageHero>
      <Downloads rel={rel} />
      <section className="t-section t-section-alt">
        <Container narrow>
          <Reveal>
            <h2 className="t-section-title" style={{ fontSize: '1.5rem' }}>Will it run on my computer?</h2>
            <div className="t-panel" style={{ marginTop: '1.25rem' }}>
              <ul className="t-keys">
                <li><span>Mac</span><span className="t-kbd-group"><span className="t-kbd">macOS 12+ · M1 to M4</span></span></li>
                <li><span>Linux</span><span className="t-kbd-group"><span className="t-kbd">Ubuntu, Debian, Fedora</span><span className="t-kbd">Easy .deb or portable App</span></span></li>
                <li><span>Windows</span><span className="t-kbd-group"><span className="t-kbd">Windows 10 / 11 · 64-bit</span></span></li>
                <li><span>From source</span><span className="t-kbd-group"><span className="t-kbd">Node 20+</span><span className="t-kbd">Rust 1.75+</span></span></li>
              </ul>
              <p className="t-micro">Not sure? Download the recommended file for your system above — it just works.</p>
            </div>
          </Reveal>
        </Container>
      </section>
    </>
  );
}
