import { BookOpen, Github } from 'lucide-react';
import { PageHero } from '../components/PageHero';
import { DocView } from '../components/DocView';
import { Container } from '../components/ui';
import { CtaBanner } from '../components/CtaBanner';
import { getDoc, DOCS_GENERATED_AT } from '../data/docs';

/* /manual renders directly from USER_MANUAL.md on GitHub (synced at build).
   No hand-written duplicate — the md file is the single source of truth. */
export function ManualPage() {
  const doc = getDoc('manual');

  if (!doc) {
    return (
      <>
        <PageHero badge={<><BookOpen size={14} /> Documentation</>} title="User Manual" sub="Manual source is syncing. Try rebuilding the site." />
        <Container narrow>
          <div className="t-manual-card"><p>docs.json has no manual entry yet. Run npm run predev.</p></div>
        </Container>
      </>
    );
  }

  const synced = new Date(DOCS_GENERATED_AT).toLocaleString();

  return (
    <>
      <PageHero
        badge={<><BookOpen size={14} /> Documentation · synced from GitHub</>}
        title={doc.heading || 'User Manual'}
        sub={`${doc.desc} Every section below is rendered from ${doc.file}.`}
      >
        <div className="t-doc-hero-meta">
          <a href={doc.githubUrl} target="_blank" rel="noreferrer" className="t-btn t-btn--secondary t-btn--sm">
            <Github size={14} /> {doc.file}
          </a>
          <span className="t-micro" style={{ margin: 0 }}>Last synced: {synced}</span>
        </div>
      </PageHero>
      <section className="t-section" style={{ paddingTop: '1rem' }}>
        <Container>
          <DocView doc={doc} />
        </Container>
      </section>
      <CtaBanner />
    </>
  );
}
