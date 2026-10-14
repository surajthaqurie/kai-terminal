// Minimal dependency-free Markdown renderer for the synced user manual.
// Supports: headings, fenced code, tables, lists, blockquotes, hr,
// bold/italic/inline-code/links/images. Raw HTML is escaped.

import { REPO_URL } from '../data/site';

export type TocItem = { id: string; level: number; text: string };

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderInline(src: string): string {
  // Escape first, then apply inline tokens on escaped text.
  let out = escapeHtml(src);

  // Checkboxes: [x] or [ ]
  out = out.replace(/^\[x\]\s+/i, '☑ ').replace(/^\[ \]\s+/, '☐ ');

  // Images: ![alt](url)
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*?)&quot;)?\)/g, (_m, alt, url) => {
    const safeUrl = String(url).startsWith('http') || String(url).startsWith('/') || String(url).startsWith('.')
      ? String(url)
      : '#';
    return `<img src="${safeUrl}" alt="${String(alt).slice(0, 200)}" loading="lazy" />`;
  });
  // Links: [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*?)&quot;)?\)/g, (_m, text, url) => {
    const raw = String(url);
    const isExternal = /^(https?:)?\/\//i.test(raw) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw);
    // Rewrite local repo .md links: manual + mcp stay on site, the rest point at GitHub.
    let href = raw;
    const mdMatch = raw.match(/([A-Z_0-9-]+(?:\.test)?\.md)(#.*)?$/i);
    if (!isExternal && mdMatch) {
      const base = mdMatch[1].toLowerCase().replace(/_/g, '-').replace(/\.md$/, '');
      if (base === 'user-manual') {
        href = '/manual' + (mdMatch[2] ?? '');
      } else if (base === 'mcp') {
        href = '/mcp' + (mdMatch[2] ?? '');
      } else {
        href = `${REPO_URL}/blob/main/${mdMatch[1]}` + (mdMatch[2] ?? '');
      }
    }
    const ext = isExternal ? ' target="_blank" rel="noreferrer"' : '';
    return `<a href="${href}"${ext}>${text}</a>`;
  });
  // Inline code (already escaped, so backticks survived)
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // Bold + italic
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  return out;
}

function splitTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

function isDelimiterRow(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

export function renderMarkdown(md: string): { html: string; toc: TocItem[] } {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const toc: TocItem[] = [];
  const usedIds = new Set<string>();
  let html = '';
  let i = 0;

  const uniqueId = (text: string) => {
    let id = slugify(text) || 'section';
    let n = 2;
    while (usedIds.has(id)) id = `${slugify(text)}-${n++}`;
    usedIds.add(id);
    return id;
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^```/.test(line.trim())) {
      const lang = line.trim().slice(3).trim().split(/\s+/)[0] ?? '';
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      const code = escapeHtml(buf.join('\n'));
      const label = lang ? `<span class="t-doc-code-lang">${escapeHtml(lang)}</span>` : '';
      html += `<div class="t-doc-code"><div class="t-doc-code-bar">${label}<button type="button" class="t-doc-copy" data-code="${encodeURIComponent(buf.join('\n'))}">Copy</button></div><pre><code>${code || ' '}</code></pre></div>`;
      continue;
    }

    // Heading
    const h = line.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      const id = uniqueId(text.replace(/`/g, ''));
      if (level === 2 || level === 3) toc.push({ id, level, text: text.replace(/`/g, '') });
      html += `<h${level} id="${id}" class="t-doc-h${level}"><a href="#${id}" class="t-doc-anchor" aria-label="Link to this section">#</a>${renderInline(text)}</h${level}>`;
      i++;
      continue;
    }

    // HR
    if (/^(\*\*\*|---|___)\s*$/.test(line.trim())) {
      html += '<hr class="t-doc-hr" />';
      i++;
      continue;
    }

    // Blockquote (group consecutive > lines)
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      let inner = '';
      let inQuoteCode = false;
      let quoteCodeBuf: string[] = [];
      for (const b of buf) {
        if (/^```/.test(b.trim())) {
          if (inQuoteCode) {
            inner += `<div class="t-doc-code" style="margin: 0.5rem 0;"><pre><code>${escapeHtml(quoteCodeBuf.join('\n'))}</code></pre></div>`;
            quoteCodeBuf = [];
            inQuoteCode = false;
          } else {
            inQuoteCode = true;
          }
        } else if (inQuoteCode) {
          quoteCodeBuf.push(b);
        } else {
          inner += (inner ? '<br />' : '') + renderInline(b);
        }
      }
      if (inQuoteCode && quoteCodeBuf.length > 0) {
        inner += `<div class="t-doc-code" style="margin: 0.5rem 0;"><pre><code>${escapeHtml(quoteCodeBuf.join('\n'))}</code></pre></div>`;
      }
      const warn = /warning|never|danger|careful/i.test(inner);
      html += `<div class="${warn ? 't-callout-warn' : 't-callout-tip'} t-doc-callout">${inner}</div>`;
      continue;
    }

    // Table
    if (line.includes('|') && i + 1 < lines.length && isDelimiterRow(lines[i + 1])) {
      const headers = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      html += '<div class="t-manual-table-wrap t-doc-table-wrap"><table class="t-manual-table"><thead><tr>';
      for (const c of headers) html += `<th>${renderInline(c)}</th>`;
      html += '</tr></thead><tbody>';
      for (const r of rows) {
        html += '<tr>';
        for (let k = 0; k < headers.length; k++) html += `<td>${renderInline(r[k] ?? '')}</td>`;
        html += '</tr>';
      }
      html += '</tbody></table></div>';
      continue;
    }

    // Lists (group consecutive -/*/+/1. lines)
    if (/^(\s*[-*+]\s+|\s*\d+\.\s+)/.test(line)) {
      const items: Array<{ ordered: boolean; text: string }> = [];
      while (i < lines.length && /^(\s*[-*+]\s+|\s*\d+\.\s+)/.test(lines[i])) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        if (!m) break;
        items.push({ ordered: /^\d/.test(m[2]), text: m[3] });
        i++;
      }
      const ordered = items.every((it) => it.ordered);
      html += ordered ? '<ol class="t-doc-list">' : '<ul class="t-doc-list">';
      for (const it of items) html += `<li>${renderInline(it.text)}</li>`;
      html += ordered ? '</ol>' : '</ul>';
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph (group consecutive non-blank, non-special lines)
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,4}\s+|```|>|\s*[-*+]\s+|\s*\d+\.\s+)/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isDelimiterRow(lines[i + 1]))
    ) {
      buf.push(lines[i]);
      i++;
    }
    html += `<p class="t-doc-p">${buf.map(renderInline).join('<br />')}</p>`;
  }

  return { html, toc };
}
