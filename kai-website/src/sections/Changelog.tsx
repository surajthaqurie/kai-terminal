import { ExternalLink } from 'lucide-react';
import { Section, SectionHead } from '../components/ui';
import { fmtDate, notesSnippet } from '../lib/format';
import { LATEST_RELEASE_URL } from '../data/site';
import { usePublishedReleases } from '../hooks/useRepo';
import pendingChanges from '../generated/changesets.json';

export type ChangesetEntry = {
  file: string;
  package: string;
  bump: string;
  summary: string;
};

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
      <SectionHead
        title="What changed"
        sub="Published releases plus pending changes tracked with changesets."
      />
      <div className="t-log">
        {releases.length > 0 ? (
          <ul className="t-log-list">
            {releases.map((r) => (
              <li key={r.tag} className="t-log-row">
                <span className="t-version">{r.tag}</span>
                <div className="t-log-main">
                  <div className="t-log-head">
                    <b>{r.name}</b>
                    {r.date ? <span className="t-log-date">{fmtDate(r.date)}</span> : null}
                  </div>
                  {r.notes ? <p className="t-log-notes">{notesSnippet(r.notes)}</p> : null}
                </div>
                <a className="t-link" href={r.url} target="_blank" rel="noreferrer">Notes <ExternalLink size={14} /></a>
              </li>
            ))}
          </ul>
        ) : (
          <div className="t-panel t-log-empty">
            <div><b>No published releases yet</b><p>Push a <code>v*</code> tag to cut the first release. Until then, every pending change is listed below.</p></div>
            <a href={LATEST_RELEASE_URL} target="_blank" rel="noreferrer" className="t-btn t-btn--secondary t-btn--sm">Releases <ExternalLink size={16} /></a>
          </div>
        )}
        {pending.length > 0 && (
          <div className="t-panel" style={{ marginTop: '1.25rem' }}>
            <div className="t-probe-head"><span>$ unreleased</span><span className="t-pill">{pending.length} pending</span></div>
            <ul className="t-keys">
              {pending.map((p) => (
                <li key={p.file}>
                  <span className="t-log-pending"><code className="t-pkg">{p.package}</code>{p.summary}</span>
                  <span className="t-kbd-group"><span className={`t-bump t-bump--${p.bump}`}>{p.bump}</span></span>
                </li>
              ))}
            </ul>
            <p className="t-micro">Tracked with changesets — lands in CHANGELOG.md on the next release.{generatedAt ? ` Synced ${fmtDate(generatedAt)}.` : ''}</p>
          </div>
        )}
      </div>
    </Section>
  );
}
