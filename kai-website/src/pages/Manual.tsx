import { BookOpen } from 'lucide-react';
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
        sub={<>Kai is a desktop terminal with a built-in CLI for running AI coding tools on your code. Commands outside Kai launch or quit the app. Everything else runs inside Kai. For full detail, visit <a href={doc.githubUrl} target="_blank" rel="noreferrer" className="t-link">USER_MANUAL.md</a>.</>}
      />
      <section className="t-section" style={{ paddingTop: '1rem' }}>
        <Container>
          <DocView key="manual" doc={doc} />
        </Container>
      </section>
      <CtaBanner />
    </>
  );
}
