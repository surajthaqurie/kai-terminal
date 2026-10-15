import { Network } from 'lucide-react';
import { PageHero } from '../components/PageHero';
import { DocView } from '../components/DocView';
import { Container } from '../components/ui';
import { CtaBanner } from '../components/CtaBanner';
import { getDoc } from '../data/docs';

/* Intro paragraph of MCP.md, hidden on the website: the page hero already
   covers it ("Local MCP server: agent wiring and tool reference"), so
   rendering it again as an Overview card just duplicates the hero. */
const MCP_INTRO =
  'Kai includes a local MCP server that runs automatically over stdio for connected AI coding tools. ' +
  'It lets a coding tool read your code map: project info, search, symbols, dependencies, context, ' +
  'task planning, graph sync, language servers, and refresh. Everything runs privately on your machine.';

export function stripMcpIntro(md: string): string {
  if (!md.includes(MCP_INTRO)) return md;
  return md.replace(MCP_INTRO, '').replace(/\n{3,}/g, '\n\n');
}

/* /mcp renders MCP.md (single source of truth), structured like /manual:
   hero with a link to the source markdown, then the reference body. */
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

  const content = stripMcpIntro(doc.content);

  return (
    <>
      <PageHero
        badge={<><Network size={14} /> MCP</>}
        title={doc.heading || 'MCP reference'}
        sub={<>{doc.desc} For full detail, visit <a href={doc.githubUrl} target="_blank" rel="noreferrer" className="t-link">MCP.md</a>.</>}
      />
      <section className="t-section" style={{ paddingTop: '1rem' }}>
        <Container>
          <DocView key="mcp" doc={{ ...doc, content }} />
        </Container>
      </section>
      <CtaBanner />
    </>
  );
}
