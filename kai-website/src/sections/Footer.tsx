import { Terminal } from 'lucide-react';
import { Link } from '../router';
import { LATEST_RELEASE_URL, REPO_URL } from '../data/site';

const COLS: Array<{ head: string; links: Array<[string, string, boolean?]> }> = [
  {
    head: 'Product',
    links: [
      ['/', 'Home'],
      ['/download', 'Download'],
      ['/changelog', 'Changelog'],
    ],
  },
  {
    head: 'Guides',
    links: [
      ['/guide', 'Getting started'],
      ['/manual', 'Commands manual'],
      ['/mcp', 'MCP reference'],
      ['/docs', 'Documentation'],
      ['/faq', 'FAQ'],
    ],
  },
  {
    head: 'Project',
    links: [
      [REPO_URL, 'GitHub', true],
      [`${REPO_URL}/issues`, 'Issues', true],
      [LATEST_RELEASE_URL, 'Releases', true],
    ],
  },
];

export function Footer() {
  return (
    <footer className="t-footer">
      <div className="t-foot-grid">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.75rem' }}>
            <div className="t-brand-mark" style={{ width: '28px', height: '28px', borderRadius: '8px' }}><Terminal size={16} color="#22d3ee" /></div>
            <span style={{ fontSize: '1.1rem', fontWeight: 800 }}>kai</span>
            <span className="t-version">MIT</span>
          </div>
          <p className="t-foot-clone">$ git clone {REPO_URL}.git</p>
          <p style={{ color: 'var(--text-tertiary)', fontSize: '.8rem', marginTop: '0.5rem', lineHeight: 1.6 }}>MIT licensed. Start at the <Link to="/guide" style={{ color: 'var(--accent-cyan-fg)' }}>setup guide</Link> or pick a file on the <Link to="/download" style={{ color: 'var(--accent-cyan-fg)' }}>download page</Link>.</p>
        </div>
        {COLS.map((col) => (
          <nav key={col.head} aria-label={col.head}>
            <h3 className="t-foot-head">{col.head}</h3>
            <ul className="t-foot-links">
              {col.links.map(([href, label, ext]) =>
                ext ? (
                  <li key={href}>
                    <a href={href} target="_blank" rel="noreferrer">{label}</a>
                  </li>
                ) : (
                  <li key={href}>
                    <Link to={href}>{label}</Link>
                  </li>
                ),
              )}
            </ul>
          </nav>
        ))}
      </div>
      <div className="t-foot-base">© 2026 Kai Contributors · MIT</div>
    </footer>
  );
}
