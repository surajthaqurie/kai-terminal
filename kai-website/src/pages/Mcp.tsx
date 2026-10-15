import { useMemo, useState } from 'react';
import { ShieldCheck, Terminal } from 'lucide-react';
import { PageHero } from '../components/PageHero';
import { Container } from '../components/ui';
import { CtaBanner } from '../components/CtaBanner';
import { getDoc } from '../data/docs';
import { renderInline } from '../lib/markdown';

type McpTool = { name: string; desc: string };

function parseTools(md: string): McpTool[] {
  const tools: McpTool[] = [];
  const lines = md.split('\n');
  let inTools = false;
  for (const line of lines) {
    if (/^##\s+Tools/i.test(line)) { inTools = true; continue; }
    if (inTools && /^##\s+/.test(line)) break;
    if (!inTools) continue;
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|?\s*$/);
    if (m && !/^tool$/i.test(m[1].trim()) && !/^[:-]+$/.test(m[1].trim())) {
      tools.push({ name: m[1].trim(), desc: m[2].trim() });
    }
  }
  return tools;
}

const COMMANDS = [
  {
    id: 'connect',
    title: 'Connect an agent',
    body: 'Auto-wire Kai MCP into an agent’s configuration. Your repository code is never modified.',
    code: 'kai mcp claude          # Wire Claude Code (~/.claude.json)\nkai mcp cursor          # Wire Cursor (.cursor/mcp.json)\nkai mcp all             # Wire every detected agent',
  },
  {
    id: 'status',
    title: 'Check status',
    body: 'Show the local MCP server status, available tools, and per-agent connection state.',
    code: 'kai mcp list            # Or: kai list mcp, kai list -m, kai list --mcp',
  },
  {
    id: 'disconnect',
    title: 'Disconnect an agent',
    body: 'Remove Kai MCP from an agent. Repository code, caches, and project maps are preserved.',
    code: 'kai remove -m claude    # Or: kai remove --mcp claude, kai mcp remove claude',
  },
];

function CodeBlock({ code }: { code: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="t-doc-code">
      <div className="t-doc-code-bar">
        <span className="t-doc-code-lang">bash</span>
        <button
          type="button"
          className="t-doc-copy"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code);
              setDone(true);
              setTimeout(() => setDone(false), 1200);
            } catch { /* clipboard unavailable */ }
          }}
        >
          {done ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

/* /mcp renders MCP.md (single source of truth) as a simple reference:
   three commands, one options note, one tools table. */
export function McpPage() {
  const doc = getDoc('mcp');
  const tools = useMemo(() => (doc ? parseTools(doc.content) : []), [doc]);

  if (!doc) {
    return (
      <>
        <PageHero badge={<><Terminal size={14} /> MCP</>} title="MCP reference" sub="The reference is not available right now." />
        <Container narrow>
          <div className="t-manual-card"><p>Run the site predev step, then reload.</p></div>
        </Container>
      </>
    );
  }

  return (
    <>
      <PageHero
        badge={<><Terminal size={14} /> MCP</>}
        title="MCP reference"
        sub={<>Kai runs a local MCP server over stdio, so connected coding tools can read your project map — privately, on your machine. Source: <a href={doc.githubUrl} target="_blank" rel="noreferrer" className="t-link">MCP.md</a>.</>}
      />
      <section className="t-section" style={{ paddingTop: '1rem' }}>
        <Container narrow>
          {COMMANDS.map((c) => (
            <div key={c.id} id={`mcp-${c.id}`} className="t-manual-card">
              <h2 className="t-doc-h2">{c.title}</h2>
              <p className="t-doc-p">{c.body}</p>
              <CodeBlock code={c.code} />
            </div>
          ))}

          <div className="t-callout-tip t-doc-callout">
            <ShieldCheck size={18} />
            <span>Options: <code>--print</code> previews the snippet, <code>--dry-run</code> simulates without writing, <code>--force</code> overwrites an existing entry, <code>--project</code> writes project-scoped config. Disconnects accept <code>--dry-run</code> to preview first.</span>
          </div>

          <div className="t-manual-card">
            <h2 className="t-doc-h2">Tools</h2>
            <p className="t-doc-p">{tools.length} local tools your agent can call. Everything runs on-device.</p>
            <div className="t-manual-table-wrap">
              <table className="t-manual-table">
                <thead><tr><th>Tool</th><th>Does</th></tr></thead>
                <tbody>
                  {tools.map((t) => (
                    <tr key={t.name}>
                      <td><code>{t.name}</code></td>
                      <td dangerouslySetInnerHTML={{ __html: renderInline(t.desc) }} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="t-micro">
              Full detail in <a href={doc.githubUrl} target="_blank" rel="noreferrer" className="t-link">MCP.md</a>.
            </p>
          </div>
        </Container>
      </section>
      <CtaBanner />
    </>
  );
}
