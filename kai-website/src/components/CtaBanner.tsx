import { ArrowRight, Download, ScrollText } from 'lucide-react';
import { Link } from '../router';

/* Conversion banner reused at the bottom of Home / Guide / FAQ. */
export function CtaBanner() {
  return (
    <section className="t-section" style={{ paddingTop: '1rem' }}>
      <div className="t-container">
        <div className="t-cta">
          <div>
            <h2>Download Kai</h2>
            <p>Installers for macOS, Linux and Windows are on the download page and GitHub Releases.</p>
          </div>
          <div className="t-cta-actions">
            <Link to="/download" className="t-btn t-btn--primary">
              <Download size={18} /> Download <ArrowRight size={16} />
            </Link>
            <Link to="/changelog" className="t-btn t-btn--secondary">
              <ScrollText size={18} /> Changelog
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
