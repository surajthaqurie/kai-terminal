import { BookOpen, Download, ArrowRight } from 'lucide-react';
import { PageHero } from '../components/PageHero';
import { InstallBar } from '../components/InstallBar';
import { Downloads } from '../sections/Downloads';
import { Container, Reveal } from '../components/ui';
import { Link } from '../router';
import type { SerializableRelease } from '../lib/release';

/* Dedicated install page: auto-fed by useLatestRelease (GitHub API).
   Shows live assets when a release exists, source fallback otherwise. */
export function DownloadPage({ rel }: { rel: SerializableRelease }) {
  return (
    <>
      <PageHero
        badge={<><Download size={14} /> Download</>}
        title="Download Kai"
        sub={`Version ${rel.tag} · Files are on GitHub Releases. Pick your system below.`}
      >
        <InstallBar short={rel.short} />
      </PageHero>
      <Downloads rel={rel} showHead={false} />
      <section className="t-section t-section-alt">
        <Container narrow>
          <Reveal>
            <h2 className="t-section-title" style={{ fontSize: '1.5rem' }}>Requirements</h2>
            <div className="t-panel" style={{ marginTop: '1.25rem' }}>
              <ul className="t-keys">
                <li><span>macOS</span><span className="t-kbd-group"><span className="t-kbd">macOS 12+ · M1 to M4</span></span></li>
                <li><span>Linux</span><span className="t-kbd-group"><span className="t-kbd">Ubuntu, Debian, Fedora</span><span className="t-kbd">Easy .deb or portable App</span></span></li>
                <li><span>Windows</span><span className="t-kbd-group"><span className="t-kbd">Windows 10 / 11 · 64-bit</span></span></li>
                <li><span>From source</span><span className="t-kbd-group"><span className="t-kbd">Node 20+</span><span className="t-kbd">Rust 1.75+</span></span></li>
              </ul>
              <p className="t-micro">Verify the checksum on the GitHub release page before running, especially on shared machines.</p>
            </div>
          </Reveal>
        </Container>
      </section>
      <section className="t-section" style={{ paddingTop: '1rem' }}>
        <Container>
          <div className="t-cta">
            <div>
              <h2>Ready to get started?</h2>
              <p>Follow our quick setup guide to connect your first AI agent, or read the full user manual.</p>
            </div>
            <div className="t-cta-actions">
              <Link to="/guide" className="t-btn t-btn--primary">
                Setup guide <ArrowRight size={16} />
              </Link>
              <Link to="/commands" className="t-btn t-btn--secondary">
                <BookOpen size={18} /> User manual
              </Link>
            </div>
          </div>
        </Container>
      </section>
    </>
  );
}
