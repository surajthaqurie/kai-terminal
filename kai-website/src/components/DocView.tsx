'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { renderMarkdown, slugify, type TocItem } from '../lib/markdown';

export type DocEntry = {
  slug: string;
  file: string;
  title: string;
  desc: string;
  heading: string;
  githubUrl: string;
  rawUrl: string;
  updatedAt: string | null;
  content: string;
};

type DocSection = {
  id: string;
  title: string;
  html: string;
  toc: TocItem[];
  plain: string;
};

function splitSections(md: string): DocSection[] {
  // The page hero already shows the document's # H1 title, so drop it here —
  // otherwise the first card repeats the hero heading.
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const firstH1 = lines.findIndex((l) => /^#\s+/.test(l));
  const body = firstH1 >= 0 ? [...lines.slice(0, firstH1), ...lines.slice(firstH1 + 1)].join('\n') : md;
  const chunks: string[][] = [[]];
  for (const line of body.split('\n')) {
    if (/^##\s+/.test(line) && chunks[chunks.length - 1].length > 0) {
      chunks.push([line]);
    } else {
      chunks[chunks.length - 1].push(line);
    }
  }
  return chunks
    .map((chunk) => chunk.join('\n').trim())
    .filter(Boolean)
    .map((text) => {
      const m = text.match(/^##\s+(.+?)\s*$/m);
      const title = m ? m[1].replace(/`/g, '') : 'Overview';
      const { html, toc } = renderMarkdown(text);
      const plain = text.toLowerCase();
      return { id: slugify(title) || 'overview', title, html, toc, plain };
    });
}

export function DocView({ doc, flatToc = false }: { doc: DocEntry; flatToc?: boolean }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<string | null>(null);
  // Open by default: on mobile the topics list renders above the content,
  // so headings are visible without an extra tap. The toggle can collapse it.
  const [tocOpen, setTocOpen] = useState(true);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const sections = useMemo(() => splitSections(doc.content), [doc.content]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections.filter((s) => s.plain.includes(q) || s.title.toLowerCase().includes(q));
  }, [sections, query]);

  const flat = useMemo(
    () => filtered.flatMap((s) => s.toc.filter((t) => t.level === 3)),
    [filtered],
  );
  const useFlat = flatToc && flat.length > 0;

  // Scroll-spy on rendered sections and subsections.
  // Initialise from the URL hash so a deep link (e.g. /commands#kai-open)
  // highlights immediately, then keep it in sync on back/forward.
  useEffect(() => {
    const fromHash = () => decodeURIComponent((window.location.hash || '').slice(1));
    const h = fromHash();
    if (h) setActive(h);
    const onHash = () => {
      const id = fromHash();
      if (id) setActive(id);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [doc.slug]);

  // Scroll-spy on rendered sections and subsections.
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll<HTMLElement>('[data-doc-section], h3[id], h4[id]'));
    if (els.length === 0 || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const id = (e.target as HTMLElement).dataset.docSection || e.target.id;
            if (id) setActive(id);
          }
        }
      },
      { rootMargin: '-15% 0px -70% 0px', threshold: 0 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [filtered.length, doc.slug]);

  // Copy-button delegation for rendered code blocks.
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    const onClick = async (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.t-doc-copy');
      if (!btn) return;
      try {
        await navigator.clipboard.writeText(decodeURIComponent(btn.dataset.code ?? ''));
        const prev = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = prev; }, 1200);
      } catch { /* clipboard unavailable */ }
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [filtered.length, doc.slug]);

  const go = (id: string) => {
    setActive(id);
    setTocOpen(false);
  };

  return (
    <div className="t-doc-layout">
      <aside className="t-doc-side" aria-label="Topics" data-toc={tocOpen ? 'open' : 'closed'}>
        <div className="t-doc-side-sticky">
          <div className="t-doc-search">
            <Search size={15} className="t-doc-search-icon" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search topics…"
              aria-label="Search topics"
              className="t-doc-search-input"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="Clear filter" className="t-doc-search-clear">
                <X size={14} />
              </button>
            )}
          </div>
          <button
            type="button"
            className="t-doc-toc-toggle"
            aria-expanded={tocOpen}
            onClick={() => setTocOpen((v) => !v)}
          >
            Topics ({useFlat ? flat.length : filtered.length})
            <ChevronDown size={15} style={{ transform: tocOpen ? 'rotate(180deg)' : 'none' }} />
          </button>
          <nav aria-label="Topics" className="t-doc-toc">
            {useFlat ? (
              <>
                {flat.map((t) => (
                  <a
                    key={t.id}
                    href={`#${t.id}`}
                    data-active={active === t.id}
                    className="t-doc-toc-link"
                    onClick={() => go(t.id)}
                  >
                    {t.text}
                  </a>
                ))}
              </>
            ) : (
              <>
                {(() => {
                  // `kai open` stays first, `kai health` follows, and `kai close` stays last as
                  // heading-style rows with no group heading and no count.
                  // Found by command id wherever they live (`## Open` first,
                  // `## Close` last), so each keeps its own header. Their
                  // parent sections are hidden from the groups below.
                  const h3s = filtered.flatMap((s) => s.toc.filter((t) => t.level === 3));
                  const topBookend = h3s.find((t) => t.id === 'kai-open') ?? null;
                  const healthBookend = h3s.find((t) => t.id === 'kai-health') ?? null;
                  const bottomBookend = h3s.find((t) => t.id === 'kai-close') ?? null;
                  const bookendIds = new Set(
                    [topBookend?.id, healthBookend?.id, bottomBookend?.id].filter((id): id is string => Boolean(id)),
                  );
                  const groups = filtered.filter((s) => {
                    const subs = s.toc.filter((t) => t.level === 3);
                    if (subs.length === 0) return true;
                    return !subs.every((t) => bookendIds.has(t.id));
                  });
                  const bookendRow = (sub: TocItem) => (
                    <a
                      key={sub.id}
                      href={`#${sub.id}`}
                      data-active={active === sub.id}
                      className="t-doc-toc-link t-doc-toc-link--head"
                      onClick={() => go(sub.id)}
                    >
                      <span>{sub.text}</span>
                    </a>
                  );
                  return (
                    <>
                      {topBookend && <div className="t-doc-toc-group">{bookendRow(topBookend)}</div>}
                      {healthBookend && <div className="t-doc-toc-group">{bookendRow(healthBookend)}</div>}
                      {groups.map((s) => {
                        const toc = s.toc.filter(
                          (t) => !(t.level === 3 && bookendIds.has(t.id)),
                        );
                        const subs = toc.filter((t) => t.level === 3);
                        const subIds = subs.map((t) => t.id);
                        const groupActive = active === s.id || (active !== null && subIds.includes(active));
                        // Nest #### entries under their preceding ###.
                        const nested: Array<{ h3: TocItem; h4s: TocItem[] }> = [];
                        for (const t of toc) {
                          if (t.level === 3) nested.push({ h3: t, h4s: [] });
                          else if (t.level === 4 && nested.length > 0) nested[nested.length - 1].h4s.push(t);
                        }
                        return (
                          <div key={s.id} className="t-doc-toc-group">
                            <a
                              href={`#${s.id}`}
                              data-active={groupActive}
                              className="t-doc-toc-link t-doc-toc-link--head"
                              onClick={() => go(s.id)}
                            >
                              <span>{s.title}</span>
                            </a>
                            {nested.length > 0 && (
                              <div className="t-doc-toc-sub">
                                {nested.map(({ h3, h4s }) => {
                                  const h3Active = active === h3.id || h4s.some((h) => h.id === active);
                                  return (
                                    <Fragment key={h3.id}>
                                      <a
                                        href={`#${h3.id}`}
                                        data-active={h3Active}
                                        className="t-doc-toc-sublink"
                                        onClick={() => go(h3.id)}
                                      >
                                        {h3.text}
                                      </a>
                                      {h4s.length > 0 && (
                                        <div className="t-doc-toc-subsub">
                                          {h4s.map((h) => (
                                            <a
                                              key={h.id}
                                              href={`#${h.id}`}
                                              data-active={active === h.id}
                                              className="t-doc-toc-subsublink"
                                              onClick={() => go(h.id)}
                                            >
                                              {h.text}
                                            </a>
                                          ))}
                                        </div>
                                      )}
                                    </Fragment>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {bottomBookend && <div className="t-doc-toc-group">{bookendRow(bottomBookend)}</div>}
                    </>
                  );
                })()}
              </>
            )}
            {filtered.length === 0 && <p className="t-micro">No topics match “{query}”.</p>}
          </nav>
        </div>
      </aside>

      <div className="t-doc-body" ref={bodyRef}>
        {filtered.map((s) => (
          <section key={s.id} id={s.id} data-doc-section={s.id} className="t-manual-card t-doc-section" aria-label={s.title}>
            <div dangerouslySetInnerHTML={{ __html: s.html }} />
          </section>
        ))}
        {filtered.length === 0 && (
          <div className="t-manual-card">
            <p style={{ color: 'var(--text-secondary)' }}>Nothing matches your filter. Clear the search to see all {sections.length} sections.</p>
          </div>
        )}
      </div>
    </div>
  );
}
