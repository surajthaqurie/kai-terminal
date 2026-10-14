import { useState } from 'react';
import { Download, Github, Menu, Moon, Sun, Terminal, X } from 'lucide-react';
import { useTheme } from '../theme/ThemeContext';
import { useRepoStars } from '../hooks/useRepo';
import { Link } from '../router';
import { REPO_URL } from '../data/site';

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      className="t-theme-toggle"
      onClick={toggle}
      aria-pressed={dark}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}

const NAV = [
  ['/guide', 'Guide'],
  ['/manual', 'Commands'],
  ['/mcp', 'MCP'],
  ['/download', 'Download'],
  ['/changelog', 'Changelog'],
  ['/faq', 'FAQ'],
] as const;

export function SiteHeader({ version }: { version: string }) {
  const [open, setOpen] = useState(false);
  const stars = useRepoStars();
  return (
    <header className="t-header">
      <div className="t-header-inner" style={{ position: 'relative' }}>
        <Link to="/" className="t-brand" aria-label="Kai home" onClick={() => setOpen(false)}>
          <div className="t-brand-mark">
            <Terminal size={22} color="#ffffff" />
          </div>
          <div>
            <span className="t-brand-name">kai</span>
            <span className="t-version">{version}</span>
          </div>
        </Link>

        <nav className="t-nav" data-open={open} aria-label="Primary">
          {NAV.map(([href, label]) => (
            <Link key={href} to={href} onClick={() => setOpen(false)}>
              {label}
            </Link>
          ))}
        </nav>

        <div className="t-header-actions">
          <ThemeToggle />
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="t-btn t-btn--secondary t-btn--sm t-star">
            <Github size={16} /> <span className="t-header-cta-label">Star</span>
            {stars ? <span className="t-star-n">{stars}</span> : null}
          </a>
          <Link to="/download" className="t-btn t-btn--primary t-btn--sm">
            <Download size={16} /> <span className="t-header-cta-label">Get Kai</span>
          </Link>
          <button
            type="button"
            className="t-theme-toggle t-menu-btn"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? 'Close menu' : 'Open menu'}
          >
            {open ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </div>
    </header>
  );
}
