import { Download, ExternalLink, Monitor, PackageCheck } from 'lucide-react';
import { Badge, Card, Section } from '../components/ui';
import { archLabel, fmtSize } from '../lib/format';
import { LATEST_RELEASE_URL } from '../data/site';
import type { LatestRelease } from '../hooks/useRepo';

export function Downloads({ rel }: { rel: LatestRelease }) {
  return (
    <Section id="downloads">
      <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
        <Badge tone="green"><PackageCheck size={14} /> Native builds · GitHub Releases</Badge>
        <h2 className="t-section-title">Download Kai</h2>
        <p className="t-section-sub">
          {`${rel.tag} · one direct installer per OS · Windows, Linux, macOS`}
        </p>
      </div>

      <div className="t-grid-3" style={{ marginBottom: '1.5rem' }}>
        {[
          {
            os: 'Windows',
            sub: '10 / 11 · x64',
            files: [
              ...rel.assets.filter((a) => a.name.toLowerCase().endsWith('setup.exe')),
              ...rel.assets.filter((a) => a.name.toLowerCase().endsWith('.msi')),
            ],
            fallback: [
              { name: `Kai_${rel.short}_x64-setup.exe`, url: rel.asset((n) => n.toLowerCase().endsWith('setup.exe'), `Kai_0.1.0_x64-setup.exe`), size: 0 },
              { name: `Kai_${rel.short}_x64_en-US.msi`, url: rel.asset((n) => n.toLowerCase().endsWith('.msi'), `Kai_0.1.0_x64_en-US.msi`), size: 0 },
            ],
          },
          {
            os: 'Linux',
            sub: '.deb + .AppImage · x64 / ARM64',
            files: [
              ...rel.assets.filter((a) => a.name.toLowerCase().endsWith('.deb')),
              ...rel.assets.filter((a) => a.name.toLowerCase().endsWith('.appimage')),
            ],
            fallback: [
              { name: `kai_${rel.short}_amd64.deb`, url: rel.asset((n) => n.toLowerCase().includes('amd64') && n.toLowerCase().endsWith('.deb'), 'kai_0.1.0_amd64.deb'), size: 0 },
              { name: `kai_${rel.short}_amd64.AppImage`, url: rel.asset((n) => n.toLowerCase().includes('amd64') && n.toLowerCase().endsWith('.appimage'), 'kai_0.1.0_amd64.AppImage'), size: 0 },
            ],
          },
          {
            os: 'macOS',
            sub: '12+ · Apple Silicon',
            files: rel.assets.filter((a) => a.name.toLowerCase().endsWith('.dmg')),
            fallback: [
              { name: `Kai_${rel.short}_aarch64.dmg`, url: rel.asset((n) => n.toLowerCase().endsWith('.dmg'), `Kai_0.1.0_aarch64.dmg`), size: 0 },
            ],
          },
        ].map((d) => {
          const rows = d.files.length > 0 ? d.files : d.fallback;
          return (
            <Card key={d.os} solid>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '.6rem' }}><Monitor size={20} /> {d.os}</h3>
              <p style={{ marginBottom: '1.25rem' }}>{d.sub}</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {rows.map((f, i) => (
                  <a key={f.name} className={`t-dl${i === 0 ? ' t-dl--accent-cyan' : ''}`} href={f.url}>
                    <span className="t-dl-name">{f.name}{archLabel(f.name) ? ` · ${archLabel(f.name)}` : ''}</span>
                    <span className="t-dl-meta">{fmtSize(f.size)}<Download size={16} /></span>
                  </a>
                ))}
              </div>
            </Card>
          );
        })}
      </div>

      <div className="t-panel t-verify">
        <div><b>Verify + see all artifacts</b><p>Changelog, assets, full tag history.</p></div>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <a href="/changelog" className="t-btn t-btn--secondary t-btn--sm">Changelog</a>
          <a href={LATEST_RELEASE_URL} target="_blank" rel="noreferrer" className="t-btn t-btn--primary t-btn--sm">Releases <ExternalLink size={16} /></a>
        </div>
      </div>
    </Section>
  );
}
