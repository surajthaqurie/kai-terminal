import { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, FileText, Github, Search, X } from 'lucide-react';
import { renderMarkdown, slugify, type TocItem } from '../lib/markdown';
import { CopyBtn } from './CopyBtn';

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
  const lines = md.split('\n');
  const chunks: string[][] = [[]];
  for (const line of lines) {
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

export function DocView({ doc }: { doc: DocEntry }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const sections = useMemo(() => splitSections(doc.content), [doc.content]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections.filter((s) => s.plain.includes(q) || s.title.toLowerCase().includes(q));
  }, [sections, query]);

  // Scroll-spy on rendered sections.
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll<HTMLElement>('[data-doc-section]'));
    if (els.length === 0 || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActive((e.target as HTMLElement).dataset.docSection ?? null);
        }
      },
      { rootMargin: '-20% 0px -65% 0px', threshold: 0 },
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

  const updated = doc.updatedAt ? new Date(doc.updatedAt).toLocaleDateString() : null;

  return (
    <div className="t-doc-layout">
      <aside className="t-doc-side" aria-label="On this page">
        <div className="t-doc-side-sticky">
          <div className="t-doc-source">
            <span className="t-doc-source-file"><FileText size={13} /> {doc.file}</span>
            {updated && <span className="t-doc-source-date">Synced {updated}</span>}
          </div>
          <div className="t-doc-search">
            <Search size={15} className="t-doc-search-icon" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter sections…"
              aria-label={`Filter ${doc.title}`}
              className="t-doc-search-input"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="Clear filter" className="t-doc-search-clear">
                <X size={14} />
              </button>
            )}
          </div>
          <nav aria-label="Document sections" className="t-doc-toc">
            {filtered.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                data-active={active === s.id}
                className="t-doc-toc-link"
                onClick={() => setActive(s.id)}
              >
                {s.title}
              </a>
            ))}
            {filtered.length === 0 && <p className="t-micro">No sections match “{query}”.</p>}
          </nav>
          <div className="t-doc-side-links">
            <a href={doc.githubUrl} target="_blank" rel="noreferrer"><Github size={13} /> View on GitHub</a>
            <a href={doc.rawUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Raw markdown</a>
          </div>
        </div>
      </aside>

      <div className="t-doc-body" ref={bodyRef}>
        {filtered.map((s) => (
          <section key={s.id} id={s.id} data-doc-section={s.id} className="t-manual-card t-doc-section" aria-label={s.title}>
            <div dangerouslySetInnerHTML={{ __html: s.html }} />
            <div className="t-doc-section-foot">
              <a href={`#${s.id}`} className="t-link">Link to this section</a>
              <CopyBtn text={`# ${s.title}`} />
            </div>
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
