import { ExternalLink, ScrollText, Sparkles } from 'lucide-react';
import { Badge, Section } from '../components/ui';
import { Link } from '../router';
import { fmtDate } from '../lib/format';
import { LATEST_RELEASE_URL } from '../data/site';
import { usePublishedReleases } from '../hooks/useRepo';
import { renderInline } from '../lib/markdown';

/* One helper for both release notes and changeset summaries:
   first line = heading, rest = bullets. If all are bullets, head is empty. */
function splitNotes(text: string) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { head: '', bullets: [] as string[] };
  if (/^[-*•]\s+/.test(lines[0])) {
    return {
      head: '',
      bullets: lines.map((l) => l.replace(/^[-*•]\s+/, '')),
    };
  }
  return {
    head: lines[0].replace(/:$/, ''),
    bullets: lines.slice(1).map((l) => l.replace(/^[-*•]\s+/, '')),
  };
}

const norm = (s: string) =>
  s.toLowerCase().replace(/`+/g, '').replace(/[*_~#>/\\[\]()]/g, '').replace(/\s+/g, ' ').trim();

/* "Kai v0.1.5 — New `kai mcp`…" → "New `kai mcp`…". Keeps inline code,
   drops the redundant version prefix so the card title isn't a second heading. */
function cleanTitle(name: string, tag: string): string {
  let t = (name || '').trim();
  t = t.replace(/^kai\s+v?\d+\.\d+\.\d+\s*[—–-]\s*/i, '').trim();
  t = t.replace(new RegExp(`^${tag.replace(/\./g, '\\.')}\\s*[—–-]?\\s*`, 'i'), '').trim();
  return t || `Release ${tag}`;
}

export function Changelog({ limit = 6, showHead = true }: { limit?: number; showHead?: boolean }) {
  const releases = usePublishedReleases(limit);

  return (
    <Section id="changelog" alt>
      {showHead && (
      <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
        <Badge tone="cyan"><ScrollText size={14} /> What's new</Badge>
        <h2 className="t-section-title">What's new in Kai</h2>
        <p className="t-section-sub">
          Release notes, newest first. Full history lives on GitHub Releases.
        </p>
      </div>
      )}

      <div className="t-log">
        {releases.length > 0 ? (
          <ul className="t-log-list">
            {releases.map((r, idx) => {
              const { head, bullets } = splitNotes(r.notes);
              const title = cleanTitle(r.name, r.tag);
              // The GitHub release title usually repeats the first bullet
              // ("New `kai mcp` command family…") — drop the duplicate so the
              // card reads: version + title + remaining bullets.
              const items = bullets.filter((b, i) => i > 0 || norm(b) !== norm(title));
              return (
                <li key={r.tag} className="t-log-row t-log-card">
                  <div className="t-log-top">
                    <div className="t-log-tags">
                      <span className="t-version t-version--lg">{r.tag}</span>
                      {idx === 0 && (
                        <span className="t-pill t-pill--latest">
                          <Sparkles size={11} /> Latest Release
                        </span>
                      )}
                    </div>
                    {r.date ? (
                      <time className="t-log-date" dateTime={r.date}>{fmtDate(r.date)}</time>
                    ) : null}
                  </div>

                  <div className="t-log-main">
                    <h3 className="t-log-title" dangerouslySetInnerHTML={{ __html: renderInline(title) }} />
                    {head && <p className="t-log-notes" dangerouslySetInnerHTML={{ __html: renderInline(head) }} />}
                    {items.length > 0 && (
                      <ul className="t-log-bullets">
                        {items.map((b, bIdx) => (
                          <li key={bIdx} dangerouslySetInnerHTML={{ __html: renderInline(b) }} />
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="t-log-foot">
                    <Link to="/download" className="t-btn t-btn--secondary t-btn--sm t-log-btn">
                      Direct Downloads
                    </Link>
                    <a className="t-link" href={r.url} target="_blank" rel="noreferrer">
                      GitHub Release Notes <ExternalLink size={13} />
                    </a>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="t-panel t-log-empty">
            <div>
              <b>No releases yet</b>
              <p>We are getting the first release ready. Please check back soon, or run Kai from source.</p>
            </div>
            <a href={LATEST_RELEASE_URL} target="_blank" rel="noreferrer" className="t-btn t-btn--secondary t-btn--sm">
              Releases <ExternalLink size={16} />
            </a>
          </div>
        )}

      </div>
    </Section>
  );
}
