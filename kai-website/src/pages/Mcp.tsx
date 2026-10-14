import { Network } from 'lucide-react';
import { PageHero } from '../components/PageHero';
import { DocView } from '../components/DocView';
import { Container } from '../components/ui';
import { CtaBanner } from '../components/CtaBanner';
import { getDoc } from '../data/docs';

/* /mcp renders MCP.md (single source of truth). */
export function McpPage() {
  const doc = getDoc('mcp');

  if (!doc) {
    return (
      <>
        <PageHero badge={<><Network size={14} /> MCP</>} title="MCP reference" sub="The reference is not available right now." />
        <Container narrow>
          <div className="t-manual-card"><p>Run the site predev step, then reload.</p></div>
        </Container>
      </>
    );
  }

  return (
    <>
      <PageHero
        badge={<><Network size={14} /> MCP</>}
        title={doc.heading || 'MCP reference'}
        sub={doc.desc}
      />
      <section className="t-section" style={{ paddingTop: '1rem' }}>
        <Container>
          <DocView key="mcp" doc={doc} />
        </Container>
      </section>
      <CtaBanner />
    </>
  );
}
