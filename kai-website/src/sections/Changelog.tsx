import { ExternalLink, GitBranch, Package, ScrollText, Sparkles } from 'lucide-react';
import { Badge, Section } from '../components/ui';
import { Link } from '../router';
import { fmtDate } from '../lib/format';
import { LATEST_RELEASE_URL } from '../data/site';
import { usePublishedReleases } from '../hooks/useRepo';
import pendingChanges from '../generated/changesets.json';

export type ChangesetEntry = {
  file: string;
  package: string;
  bump: string;
  summary: string;
};

/* One helper for both release notes and changeset summaries:
   first line = heading, rest = bullets. */
function splitNotes(text: string) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return { head: text.trim(), bullets: [] as string[] };
  return {
    head: lines[0].replace(/:$/, ''),
    bullets: lines.slice(1).map((l) => l.replace(/^[-*•]\s*/, '')),
  };
}

export function Changelog({ limit = 6 }: { limit?: number }) {
  const releases = usePublishedReleases(limit);
  const pending: ChangesetEntry[] = Array.isArray((pendingChanges as { entries?: unknown })?.entries)
    ? (pendingChanges as { entries: ChangesetEntry[] }).entries
    : [];

  return (
    <Section id="changelog" alt>
      <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
        <Badge tone="cyan"><ScrollText size={14} /> What's new</Badge>
        <h2 className="t-section-title">What's new in Kai</h2>
        <p className="t-section-sub">
          Latest updates and improvements. Simple list, newest first.
        </p>
      </div>

      <div className="t-log">
        {releases.length > 0 ? (
          <ul className="t-log-list">
            {releases.map((r, idx) => {
              const { head, bullets } = splitNotes(r.notes);
              return (
                <li key={r.tag} className="t-log-row" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', flexWrap: 'wrap', gap: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                      <span className="t-version" style={{ fontSize: '0.88rem', padding: '0.2rem 0.65rem' }}>{r.tag}</span>
                      {idx === 0 && (
                        <span className="t-pill" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                          <Sparkles size={11} /> Latest Release
                        </span>
                      )}
                    </div>
                    {r.date ? <span className="t-log-date">{fmtDate(r.date)}</span> : null}
                  </div>

                  <div className="t-log-main" style={{ width: '100%' }}>
                    <div className="t-log-head" style={{ marginBottom: '0.5rem' }}>
                      <b style={{ fontSize: '1.05rem' }}>{r.name}</b>
                    </div>
                    {head && <p className="t-log-notes" style={{ margin: '0 0 0.5rem' }}>{head}:</p>}
                    {bullets.length > 0 && (
                      <ul className="t-log-bullets">
                        {bullets.map((b, bIdx) => (
                          <li key={bIdx}>{b}</li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', paddingTop: '0.5rem', borderTop: '1px solid var(--border-subtle)', flexWrap: 'wrap', gap: '0.5rem' }}>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <Link to="/download" className="t-btn t-btn--secondary t-btn--sm" style={{ padding: '0.25rem 0.6rem', fontSize: '0.75rem' }}>
                        Direct Downloads
                      </Link>
                    </div>
                    <a className="t-link" href={r.url} target="_blank" rel="noreferrer" style={{ fontSize: '0.8rem' }}>
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

        {pending.length > 0 && (
          <div className="t-panel" style={{ marginTop: '2rem' }}>
            <div className="t-probe-head">
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600 }}>
                <GitBranch size={16} color="var(--accent-green-fg)" />
                <span>$ unreleased changes</span>
              </span>
              <span className="t-pill">{pending.length} changesets pending</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {pending.map((p) => {
                const { head, bullets } = splitNotes(p.summary);
                return (
                  <div
                    key={p.file}
                    style={{
                      padding: '0.85rem 1rem',
                      borderRadius: '8px',
                      backgroundColor: 'var(--btn-secondary-bg)',
                      border: '1px solid var(--border-subtle)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.4rem', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                        <code className="t-pkg" style={{ padding: '0.15rem 0.45rem', borderRadius: '4px', background: 'var(--bg-canvas)' }}>
                          <Package size={11} style={{ display: 'inline', marginRight: '0.25rem' }} />
                          {p.package}
                        </code>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                          {p.file}
                        </span>
                      </div>
                      <span className={`t-bump t-bump--${p.bump}`}>{p.bump} bump</span>
                    </div>

                    <div style={{ fontSize: '0.86rem', color: 'var(--text-primary)', lineHeight: 1.5 }}>
                      <b>{head}</b>
                      {bullets.length > 0 && (
                        <ul className="t-log-bullets" style={{ marginTop: '0.35rem' }}>
                          {bullets.map((b, bIdx) => (
                            <li key={bIdx}>{b}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="t-micro" style={{ marginTop: '1rem' }}>
              Coming in the next release.
            </p>
          </div>
        )}
      </div>
    </Section>
  );
}
