import { BookOpen, Github } from 'lucide-react';
import { PageHero } from '../components/PageHero';
import { DocView } from '../components/DocView';
import { Container } from '../components/ui';
import { CtaBanner } from '../components/CtaBanner';
import { getDoc } from '../data/docs';

/* /manual renders USER_MANUAL.md (single source of truth). */
export function ManualPage() {
  const doc = getDoc('manual');

  if (!doc) {
    return (
      <>
        <PageHero badge={<><BookOpen size={14} /> Reference</>} title="Commands" sub="The reference is not available right now." />
        <Container narrow>
          <div className="t-manual-card"><p>Run the site predev step, then reload.</p></div>
        </Container>
      </>
    );
  }

  return (
    <>
      <PageHero
        badge={<><BookOpen size={14} /> Reference</>}
        title={doc.heading || 'Commands'}
        sub={doc.desc || 'Every command, grouped by topic.'}
      >
        <div className="t-doc-hero-meta">
          <a href={doc.githubUrl} target="_blank" rel="noreferrer" className="t-btn t-btn--secondary t-btn--sm">
            <Github size={14} /> View on GitHub
          </a>
        </div>
      </PageHero>
      <section className="t-section" style={{ paddingTop: '1rem' }}>
        <Container>
          <DocView key="manual" doc={doc} />
        </Container>
      </section>
      <CtaBanner />
    </>
  );
}
