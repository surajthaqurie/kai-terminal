import { BookOpen, FileText, Github } from 'lucide-react';
import { PageHero } from '../components/PageHero';
import { DocView } from '../components/DocView';
import { Container, Card } from '../components/ui';
import { CtaBanner } from '../components/CtaBanner';
import { Link } from '../router';
import { DOCS, getDoc } from '../data/docs';

/* /docs — index of every synced repo markdown. /docs/:slug renders the md. */
export function DocsIndexPage() {
  return (
    <>
      <PageHero
        badge={<><BookOpen size={14} /> Docs</>}
        title="Docs"
        sub="Every page below is rendered from its markdown file on GitHub — no duplicated hand-written copies."
      />
      <section className="t-section">
        <Container>
          <div className="t-grid-3">
            {DOCS.filter((d) => d.slug !== 'manual' && d.slug !== 'mcp').map((d) => (
              <Link key={d.slug} to={`/docs/${d.slug}`} style={{ textDecoration: 'none' }}>
                <Card hover>
                  <span className="t-tag">{d.file}</span>
                  <div className="t-icon t-icon--neutral"><FileText size={22} /></div>
                  <h3>{d.title}</h3>
                  <p>{d.desc}</p>
                  <span className="t-link">Read →</span>
                </Card>
              </Link>
            ))}
          </div>
          <div className="t-guide-callout" style={{ marginTop: '2rem' }}>
            <BookOpen size={18} />
            <span>Looking for the command reference? The <Link to="/manual">User Manual</Link> is also synced — from USER_MANUAL.md.</span>
          </div>
        </Container>
      </section>
      <CtaBanner />
    </>
  );
}

export function DocDetailPage({ slug }: { slug: string }) {
  const doc = getDoc(slug);

  if (!doc) {
    return (
      <>
        <PageHero badge={<><BookOpen size={14} /> Docs</>} title="Doc not found" sub={`No synced markdown for “${slug}”.`} />
        <section className="t-section">
          <Container narrow>
            <div className="t-manual-card">
              <p>Available docs:</p>
              <ul className="t-doc-list">
                {DOCS.map((d) => (
                  <li key={d.slug}><Link to={d.slug === 'manual' ? '/manual' : d.slug === 'mcp' ? '/mcp' : `/docs/${d.slug}`}>{d.title} ({d.file})</Link></li>
                ))}
              </ul>
            </div>
          </Container>
        </section>
      </>
    );
  }

  return (
    <>
      <PageHero
        badge={<><FileText size={14} /> {doc.file}</>}
        title={doc.heading || doc.title}
        sub={doc.desc}
      >
        <div className="t-doc-hero-meta">
          <a href={doc.githubUrl} target="_blank" rel="noreferrer" className="t-btn t-btn--secondary t-btn--sm">
            <Github size={14} /> View on GitHub
          </a>
          <Link to="/docs" className="t-btn t-btn--secondary t-btn--sm">All docs</Link>
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
