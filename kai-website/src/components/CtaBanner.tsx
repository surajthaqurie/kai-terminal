import { ArrowRight, Download, ScrollText } from 'lucide-react';
import { Link } from '../router';

/* Conversion banner reused at the bottom of Home / Guide / FAQ. */
export function CtaBanner() {
  return (
    <section className="t-section" style={{ paddingTop: '1rem' }}>
      <div className="t-container">
        <div className="t-cta">
          <div>
            <h2>Get kai on your machine</h2>
            <p>One download per OS. Free MIT, zero telemetry, 30-second setup.</p>
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
