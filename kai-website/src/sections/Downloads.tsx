import { useState } from 'react';
import { Apple, AppWindow, Download, ExternalLink, PackageCheck, Terminal } from 'lucide-react';
import { Badge, Card, Section } from '../components/ui';
import { CopyBtn } from '../components/CopyBtn';
import { archLabel, fmtSize } from '../lib/format';
import { LATEST_RELEASE_URL } from '../data/site';
import type { LatestRelease } from '../hooks/useRepo';

export function Downloads({ rel }: { rel: LatestRelease }) {
  const [platformFilter, setPlatformFilter] = useState<'all' | 'apple' | 'linux' | 'windows'>('all');

  const groups = [
    {
      id: 'apple',
      os: 'Apple (macOS)',
      badge: 'Apple Silicon',
      icon: <Apple size={22} color="var(--accent-cyan-fg)" />,
      sub: 'Apple Silicon (M1–M4) · macOS 12 Monterey or later',
      cmd: `open Kai_${rel.short}_aarch64.dmg`,
      cmdLabel: 'Mount disk image & drag to /Applications',
      files: rel.assets.filter((a) => a.name.toLowerCase().endsWith('.dmg')),
      fallback: [
        {
          name: `Kai_${rel.short}_aarch64.dmg`,
          url: rel.asset((n) => n.toLowerCase().endsWith('.dmg'), `Kai_0.1.0_aarch64.dmg`),
          size: 0,
          label: 'Apple Silicon Disk Image (.dmg)',
        },
      ],
      notes: 'Unsigned build: Right-click > Open on first launch, or run xattr -cr /Applications/Kai.app',
    },
    {
      id: 'linux',
      os: 'Linux',
      badge: 'x64 & ARM64',
      icon: <Terminal size={22} color="var(--accent-green-fg)" />,
      sub: 'Ubuntu 22.04+, Debian 12+, glibc >= 2.35 · Portable AppImage',
      cmd: `sudo dpkg -i kai_${rel.short}_amd64.deb`,
      cmdLabel: 'Install via dpkg or chmod +x *.AppImage',
      files: [
        ...rel.assets.filter((a) => a.name.toLowerCase().endsWith('.deb')),
        ...rel.assets.filter((a) => a.name.toLowerCase().endsWith('.appimage')),
      ],
      fallback: [
        {
          name: `kai_${rel.short}_amd64.deb`,
          url: rel.asset((n) => n.toLowerCase().includes('amd64') && n.toLowerCase().endsWith('.deb'), 'kai_0.1.0_amd64.deb'),
          size: 0,
          label: 'Debian / Ubuntu package (x64 .deb)',
        },
        {
          name: `kai_${rel.short}_amd64.AppImage`,
          url: rel.asset((n) => n.toLowerCase().includes('amd64') && n.toLowerCase().endsWith('.appimage'), 'kai_0.1.0_amd64.AppImage'),
          size: 0,
          label: 'Portable AppImage (x64)',
        },
        {
          name: `kai_${rel.short}_arm64.deb`,
          url: rel.asset((n) => n.toLowerCase().includes('arm64') && n.toLowerCase().endsWith('.deb'), 'kai_0.1.0_arm64.deb'),
          size: 0,
          label: 'ARM64 Debian package (.deb)',
        },
      ],
      notes: 'Portable AppImage requires FUSE (libfuse2) or launch with --appimage-extract',
    },
    {
      id: 'windows',
      os: 'Windows',
      badge: '64-bit (x64)',
      icon: <AppWindow size={22} color="var(--accent-purple-fg)" />,
      sub: 'Windows 10 (1809+) & Windows 11 · 64-bit · ConPTY',
      cmd: `winget install Kai-terminal --source github`,
      cmdLabel: 'Install via winget or double-click .exe',
      files: [
        ...rel.assets.filter((a) => a.name.toLowerCase().endsWith('setup.exe')),
        ...rel.assets.filter((a) => a.name.toLowerCase().endsWith('.msi')),
      ],
      fallback: [
        {
          name: `Kai_${rel.short}_x64-setup.exe`,
          url: rel.asset((n) => n.toLowerCase().endsWith('setup.exe'), `Kai_0.1.0_x64-setup.exe`),
          size: 0,
          label: 'Setup Installer (.exe)',
        },
        {
          name: `Kai_${rel.short}_x64_en-US.msi`,
          url: rel.asset((n) => n.toLowerCase().endsWith('.msi'), `Kai_0.1.0_x64_en-US.msi`),
          size: 0,
          label: 'Windows Installer package (.msi)',
        },
      ],
      notes: 'Requires WebView2 runtime (pre-installed on Windows 11)',
    },
  ];

  const activeGroups = platformFilter === 'all'
    ? groups
    : groups.filter((g) => g.id === platformFilter);

  return (
    <Section id="downloads">
      <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
        <Badge tone="green"><PackageCheck size={14} /> Native release builds · GitHub Actions</Badge>
        <h2 className="t-section-title">Releases &amp; Direct Downloads</h2>
        <p className="t-section-sub">
          {`${rel.tag} · one direct installer per OS · Apple (macOS), Linux & Windows`}
        </p>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', gap: '0.5rem', marginBottom: '2.5rem', flexWrap: 'wrap' }}>
        {[
          { id: 'all', label: 'All Platforms' },
          { id: 'apple', label: '🍎 Apple (macOS)' },
          { id: 'linux', label: '🐧 Linux' },
          { id: 'windows', label: '🪟 Windows' },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            className="t-install-tab"
            data-active={platformFilter === tab.id}
            onClick={() => setPlatformFilter(tab.id as 'all' | 'apple' | 'linux' | 'windows')}
            style={{ padding: '0.45rem 1rem', fontSize: '0.82rem' }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="t-grid-3" style={{ marginBottom: '2rem' }}>
        {activeGroups.map((d) => {
          const rows = d.files.length > 0 ? d.files : d.fallback;
          return (
            <Card key={d.os} solid>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <h3 style={{ display: 'flex', alignItems: 'center', gap: '.6rem', margin: 0 }}>
                  {d.icon} {d.os}
                </h3>
                <span className="t-tag" style={{ margin: 0 }}>{d.badge}</span>
              </div>
              <p style={{ marginBottom: '1.25rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{d.sub}</p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                {rows.map((f, i) => (
                  <a key={f.name} className={`t-dl${i === 0 ? ' t-dl--accent-cyan' : ''}`} href={f.url}>
                    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <span className="t-dl-name">{f.name}{archLabel(f.name) ? ` · ${archLabel(f.name)}` : ''}</span>
                      {(f as { label?: string }).label && (
                        <span style={{ fontSize: '0.72rem', opacity: 0.75, fontFamily: 'var(--font-mono)' }}>{(f as { label?: string }).label}</span>
                      )}
                    </div>
                    <span className="t-dl-meta">{fmtSize(f.size)}<Download size={16} /></span>
                  </a>
                ))}
              </div>

              <div className="t-mono-row" style={{ marginTop: '1.25rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                <code style={{ fontSize: '0.78rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.cmd}</code>
                <CopyBtn text={d.cmd} />
              </div>
              <p className="t-micro" style={{ marginTop: '0.65rem', marginBottom: 0 }}>{d.notes}</p>
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
