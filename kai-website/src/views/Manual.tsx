'use client';

import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Check, Copy, Search, Terminal, X } from 'lucide-react';
import { PageHero } from '../components/PageHero';
import { Container } from '../components/ui';
import { CtaBanner } from '../components/CtaBanner';
import { getDoc } from '../data/docs';
import { renderMarkdown, slugify } from '../lib/markdown';

type RefCommand = {
  id: string;
  title: string;
  html: string;
  plain: string;
  snippet: string | null;
};

type RefGroup = {
  id: string;
  title: string;
  introHtml: string;
  commands: RefCommand[];
};

function stripH1(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const idx = lines.findIndex((l) => /^#\s+/.test(l));
  if (idx < 0) return md;
  return [...lines.slice(0, idx), ...lines.slice(idx + 1)].join('\n');
}

function firstSnippet(body: string): string | null {
  const m = body.match(/```(?:bash|sh|shell|text|console)?\s*\n([\s\S]*?)```/);
  if (!m) return null;
  const first = m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)[0];
  return first ?? null;
}

function parseManual(md: string): RefGroup[] {
  const body = stripH1(md);
  const lines = body.split('\n');
  // Split top-level ## groups. Content before the first ## becomes "Core".
  const chunks: { head: string | null; text: string }[] = [];
  let cur: string[] = [];
  let curHead: string | null = null;
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      chunks.push({ head: curHead, text: cur.join('\n').trim() });
      cur = [];
      curHead = h2[1].replace(/`/g, '');
    } else {
      cur.push(line);
    }
  }
  chunks.push({ head: curHead, text: cur.join('\n').trim() });

  return chunks
    .filter((c) => c.text)
    .map((c) => {
      const title = c.head ?? 'Core';
      const id = slugify(title) || 'core';
      // Split ### commands inside the group.
      const parts: string[][] = [[]];
      for (const line of c.text.split('\n')) {
        if (/^###\s+/.test(line) && parts[parts.length - 1].length > 0) parts.push([line]);
        else parts[parts.length - 1].push(line);
      }
      const texts = parts.map((p) => p.join('\n').trim()).filter(Boolean);
      let intro = '';
      const commands: RefCommand[] = [];
      for (const t of texts) {
        const m = t.match(/^###\s+(.+?)\s*$/m);
        if (!m) {
          intro = t;
          continue;
        }
        const cmdTitle = m[1].replace(/`/g, '').trim();
        const cmdBody = t.replace(/^###\s+.+$/m, '').trim();
        const { html } = renderMarkdown(cmdBody || '_No details yet._');
        commands.push({
          id: slugify(cmdTitle) || 'command',
          title: cmdTitle,
          html,
          plain: (cmdTitle + '\n' + cmdBody).toLowerCase(),
          snippet: firstSnippet(cmdBody),
        });
      }
      const { html: introHtml } = renderMarkdown(intro || '');
      return { id, title, introHtml, commands };
    })
    .filter((g) => g.commands.length > 0 || g.introHtml)
    // Website commands page skips the desktop-only sections (keyboard
    // shortcuts). USER_MANUAL.md stays the full source of truth for
    // the app itself; shortcuts live on the Guide page.
    .filter((g) => !/^desktop\s/i.test(g.title));
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="t-ref-copy"
      aria-label={`Copy ${text}`}
      title="Copy command"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch { /* clipboard unavailable */ }
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
      <span>{done ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

/* /commands — professional CLI reference built from USER_MANUAL.md. */
export function ManualPage() {
  const doc = getDoc('manual');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<string | null>(null);

  const groups = useMemo(() => (doc ? parseManual(doc.content) : []), [doc]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        commands: g.commands.filter((c) => c.plain.includes(q) || c.title.toLowerCase().includes(q)),
      }))
      .filter((g) => g.commands.length > 0 || g.title.toLowerCase().includes(q));
  }, [groups, query]);

  useEffect(() => {
    const h = decodeURIComponent((window.location.hash || '').slice(1));
    if (h) setActive(h);
  }, []);

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
        badge={<><BookOpen size={14} /> CLI Reference</>}
        title="Commands"
        sub="Every Kai command, grouped by workflow. Commands run inside Kai Terminal — except open and close, which launch or quit the app."
      />

      <section className="t-section" style={{ paddingTop: '1.5rem' }}>
        <Container>
          <div className="t-ref-searchbar" role="search">
            <Search size={16} className="t-ref-search-icon" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search commands — try “graph”, “agent”, “session”…"
              aria-label="Search commands"
              className="t-ref-search-input"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="t-ref-search-clear">
                <X size={14} /> Clear
              </button>
            )}
          </div>

          <div className="t-ref-layout">
            <aside className="t-ref-side" aria-label="Command groups">
              <div className="t-ref-side-sticky">
                <p className="t-ref-side-head">On this page</p>
                <nav className="t-ref-nav">
                  {filtered.map((g) => {
                    const subIds = g.commands.map((c) => c.id);
                    const groupActive = active === g.id || (active !== null && subIds.includes(active));
                    return (
                      <div key={g.id} className="t-ref-nav-group">
                        <a
                          href={`#${g.id}`}
                          data-active={groupActive}
                          className="t-ref-nav-head"
                          onClick={() => setActive(g.id)}
                        >
                          {g.title}
                        </a>
                        {g.commands.map((c) => (
                          <a
                            key={c.id}
                            href={`#${c.id}`}
                            data-active={active === c.id}
                            className="t-ref-nav-link"
                            onClick={() => setActive(c.id)}
                            title={c.title}
                          >
                            <code>{c.title}</code>
                          </a>
                        ))}
                      </div>
                    );
                  })}
                </nav>
                {filtered.length === 0 && <p className="t-micro">No commands match “{query}”.</p>}
              </div>
            </aside>

            <div className="t-ref-body">
              {filtered.map((g) => (
                <section key={g.id} id={g.id} className="t-ref-group" aria-label={g.title}>
                  <div className="t-ref-group-head">
                    <div>
                      <h2>{g.title}</h2>
                      {g.introHtml ? <div className="t-ref-group-intro" dangerouslySetInnerHTML={{ __html: g.introHtml }} /> : null}
                    </div>
                  </div>
                  <div className="t-ref-cards">
                    {g.commands.map((c) => (
                      <article key={c.id} id={c.id} className="t-ref-card" aria-label={c.title}>
                        <div className="t-ref-card-top">
                          <div className="t-ref-cmd">
                            <span className="t-ref-cmd-icon"><Terminal size={15} /></span>
                            <code>{c.title}</code>
                          </div>
                          {c.snippet ? <CopyButton text={c.snippet} /> : null}
                        </div>
                        <div className="t-ref-card-content" dangerouslySetInnerHTML={{ __html: c.html }} />
                      </article>
                    ))}
                  </div>
                </section>
              ))}
              {filtered.length === 0 && (
                <div className="t-manual-card">
                  <p style={{ color: 'var(--text-secondary)' }}>
                    Nothing matches your filter. Clear the search to see all commands.
                  </p>
                </div>
              )}
            </div>
          </div>
        </Container>
      </section>
      <CtaBanner />
    </>
  );
}
