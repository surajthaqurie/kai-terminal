import { Compass } from 'lucide-react';
import { Link } from '../router';

export function NotFoundPage() {
  return (
    <section className="t-section">
      <div className="t-container-narrow" style={{ textAlign: 'center' }}>
        <div className="t-panel t-notfound">
          <div className="t-icon t-icon--neutral" style={{ margin: '0 auto 1.25rem' }}><Compass size={24} /></div>
          <h1 className="t-section-title">404 — page not found</h1>
          <p className="t-section-sub">That route doesn&apos;t exist. Try one of these instead.</p>
          <div className="t-cta-actions" style={{ justifyContent: 'center', marginTop: '1.75rem' }}>
            <Link to="/" className="t-btn t-btn--primary">Home</Link>
            <Link to="/download" className="t-btn t-btn--secondary">Download</Link>
            <Link to="/changelog" className="t-btn t-btn--secondary">Changelog</Link>
          </div>
        </div>
      </div>
    </section>
  );
}
