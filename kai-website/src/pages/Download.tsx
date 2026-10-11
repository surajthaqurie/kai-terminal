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
        badge={<><Download size={14} /> {rel.tag} · Native builds · GitHub Releases</>}
        title="Download kai"
        sub={`${rel.tag} · one direct installer per OS · built clean on GitHub Actions.`}
      >
        <InstallBar short={rel.short} />
      </PageHero>
      <Downloads rel={rel} />
      <section className="t-section t-section-alt">
        <Container narrow>
          <Reveal>
            <h2 className="t-section-title" style={{ fontSize: '1.5rem' }}>System requirements</h2>
            <div className="t-panel" style={{ marginTop: '1.25rem' }}>
              <ul className="t-keys">
                <li><span>Windows</span><span className="t-kbd-group"><span className="t-kbd">10 / 11 · x64</span></span></li>
                <li><span>Linux</span><span className="t-kbd-group"><span className="t-kbd">.deb x64 / ARM64</span><span className="t-kbd">.AppImage</span></span></li>
                <li><span>macOS</span><span className="t-kbd-group"><span className="t-kbd">12+ · Apple Silicon</span></span></li>
                <li><span>From source</span><span className="t-kbd-group"><span className="t-kbd">Node 20+</span><span className="t-kbd">Rust 1.75+</span></span></li>
              </ul>
              <p className="t-micro">Installers are signed CI artifacts. Verify hashes on the GitHub release page before running.</p>
            </div>
          </Reveal>
        </Container>
      </section>
    </>
  );
}
