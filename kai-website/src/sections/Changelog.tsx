import { ExternalLink, GitBranch, Package, ScrollText, Sparkles } from 'lucide-react';
import { Badge, Section } from '../components/ui';
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

function parseSummary(summary: string) {
  const lines = summary.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return { heading: summary, bullets: [] };
  const first = lines[0];
  const heading = first.endsWith(':') ? first.slice(0, -1) : first;
  const bullets = lines.slice(1).map((l) => l.replace(/^[-*•]\s*/, ''));
  return { heading, bullets };
}

function parseNotes(notes: string) {
  const lines = notes.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return { intro: notes, bullets: [] };
  const first = lines[0];
  const intro = first.endsWith(':') ? first.slice(0, -1) : first;
  const bullets = lines.slice(1).map((l) => l.replace(/^[-*•]\s*/, ''));
  return { intro, bullets };
}

export function Changelog({ limit = 6 }: { limit?: number }) {
  const releases = usePublishedReleases(limit);
  const rawEntries = (pendingChanges as { entries?: unknown })?.entries;
  const pending: ChangesetEntry[] = Array.isArray(rawEntries)
    ? (rawEntries as ChangesetEntry[])
    : [];
  const generatedAt = typeof (pendingChanges as { generatedAt?: unknown })?.generatedAt === 'string'
    ? (pendingChanges as { generatedAt: string }).generatedAt
    : '';

  return (
    <Section id="changelog" alt>
      <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
        <Badge tone="cyan"><ScrollText size={14} /> Official Changelog</Badge>
        <h2 className="t-section-title">Changelog &amp; Release History</h2>
        <p className="t-section-sub">
          Official production release milestones, binary artifacts, and pending changes tracked via changesets.
        </p>
      </div>

      <div className="t-log">
        {releases.length > 0 ? (
          <ul className="t-log-list">
            {releases.map((r, idx) => {
              const { intro, bullets } = parseNotes(r.notes);
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
                    {intro && <p className="t-log-notes" style={{ margin: '0 0 0.5rem' }}>{intro}:</p>}
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
                      <a href="#downloads" className="t-btn t-btn--secondary t-btn--sm" style={{ padding: '0.25rem 0.6rem', fontSize: '0.75rem' }}>
                        Direct Downloads
                      </a>
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
              <b>No published releases yet</b>
              <p>Push a <code>v*</code> tag to cut the first release. Until then, pending changesets are tracked below.</p>
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
                const { heading, bullets } = parseSummary(p.summary);
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
                      <b>{heading}</b>
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
              Tracked with Changesets workflow — automatically compiled into CHANGELOG.md upon release.
              {generatedAt ? ` Auto-synced: ${fmtDate(generatedAt)}.` : ''}
            </p>
          </div>
        )}
      </div>
    </Section>
  );
}
