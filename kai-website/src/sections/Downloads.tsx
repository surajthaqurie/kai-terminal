import { useState } from 'react';
import { Download, ExternalLink, PackageCheck, Terminal } from 'lucide-react';
import { Badge, Section } from '../components/ui';
import { Link } from '../router';
import { CopyBtn } from '../components/CopyBtn';
import { fmtSize } from '../lib/format';
import type { OsId } from '../lib/os';
import { LATEST_RELEASE_URL, REPO_URL } from '../data/site';
import type { LatestRelease } from '../hooks/useRepo';

type PlatformInstaller = {
  name: string;
  url: string;
  size: number;
  label: string;
  format: string;
  arch: string;
  desc: string;
  recommended?: boolean;
};

type PlatformGroup = {
  id: OsId;
  os: string;
  badge: string;
  sub: string;
  installers: PlatformInstaller[];
  cmd: string;
  cmdLabel: string;
  note: string;
};

export function Downloads({ rel }: { rel: LatestRelease }) {
  // Show everything by default — the user picks, we don't guess.
  const [platformFilter, setPlatformFilter] = useState<'all' | OsId>('all');

  const groups: PlatformGroup[] = [
    {
      id: 'macos',
      os: 'macOS',
      badge: 'M1–M4 · ARM64',
      sub: 'macOS 12 or newer · For M1, M2, M3 and M4 Macs',
      installers: [
        {
          name: `kai_${rel.short}_aarch64.dmg`,
          url: rel.asset((n) => n.toLowerCase().endsWith('.dmg'), `kai_${rel.short}_aarch64.dmg`),
          size: rel.assets.find((a) => a.name.toLowerCase().endsWith('.dmg'))?.size ?? 0,
          label: 'Mac Installer',
          format: '.dmg',
          arch: 'ARM64',
          desc: 'Open the file and drag Kai to Applications. Simple.',
          recommended: true,
        },
      ],
      cmd: `open kai_${rel.short}_aarch64.dmg`,
      cmdLabel: 'Open and install',
      note: 'First time? Right-click Kai and choose Open.',
    },
    {
      id: 'linux',
      os: 'Linux',
      badge: 'x86_64 & ARM64',
      sub: 'Ubuntu, Debian, Fedora and more',
      installers: [
        {
          name: `kai_${rel.short}_amd64.deb`,
          url: rel.asset((n) => n.toLowerCase().includes('amd64') && n.toLowerCase().endsWith('.deb'), `kai_${rel.short}_amd64.deb`),
          size: rel.assets.find((a) => a.name.toLowerCase().includes('amd64') && a.name.toLowerCase().endsWith('.deb'))?.size ?? 0,
          label: 'Linux Installer',
          format: '.deb',
          arch: 'x86_64',
          desc: 'Best for Ubuntu and Debian. Double-click to install.',
          recommended: true,
        },
        {
          name: `kai_${rel.short}_amd64.AppImage`,
          url: rel.asset((n) => n.toLowerCase().includes('amd64') && n.toLowerCase().endsWith('.appimage'), `kai_${rel.short}_amd64.AppImage`),
          size: rel.assets.find((a) => a.name.toLowerCase().includes('amd64') && a.name.toLowerCase().endsWith('.appimage'))?.size ?? 0,
          label: 'Portable App',
          format: '.AppImage',
          arch: 'x86_64',
          desc: 'Works on most Linux systems. No install needed.',
        },
        {
          name: `kai_${rel.short}_arm64.deb`,
          url: rel.asset((n) => n.toLowerCase().includes('arm64') && n.toLowerCase().endsWith('.deb'), `kai_${rel.short}_arm64.deb`),
          size: rel.assets.find((a) => a.name.toLowerCase().includes('arm64') && a.name.toLowerCase().endsWith('.deb'))?.size ?? 0,
          label: 'Linux Installer (ARM)',
          format: '.deb',
          arch: 'ARM64',
          desc: 'For ARM computers like Raspberry Pi.',
        },
        {
          name: `kai_${rel.short}_arm64.AppImage`,
          url: rel.asset((n) => n.toLowerCase().includes('arm64') && n.toLowerCase().endsWith('.appimage'), `kai_${rel.short}_arm64.AppImage`),
          size: rel.assets.find((a) => a.name.toLowerCase().includes('arm64') && a.name.toLowerCase().endsWith('.appimage'))?.size ?? 0,
          label: 'Portable App (ARM)',
          format: '.AppImage',
          arch: 'ARM64',
          desc: 'Portable file for ARM systems.',
        },
      ],
      cmd: `sudo dpkg -i kai_${rel.short}_amd64.deb`,
      cmdLabel: 'Install with one command',
      note: 'AppImage not opening? Run it with --appimage-extract-and-run.',
    },
    {
      id: 'windows',
      os: 'Windows',
      badge: '64-bit · ConPTY',
      sub: 'Windows 10 and 11 · 64-bit',
      installers: [
        {
          name: `kai_${rel.short}_x64-setup.exe`,
          url: rel.asset((n) => n.toLowerCase().endsWith('setup.exe'), `kai_${rel.short}_x64-setup.exe`),
          size: rel.assets.find((a) => a.name.toLowerCase().endsWith('setup.exe'))?.size ?? 0,
          label: 'Windows Setup',
          format: '.exe',
          arch: 'x64',
          desc: 'Normal setup. Double-click and follow the steps.',
          recommended: true,
        },
        {
          name: `kai_${rel.short}_x64_en-US.msi`,
          url: rel.asset((n) => n.toLowerCase().endsWith('.msi'), `kai_${rel.short}_x64_en-US.msi`),
          size: rel.assets.find((a) => a.name.toLowerCase().endsWith('.msi'))?.size ?? 0,
          label: 'Windows Installer',
          format: '.msi',
          arch: 'x64',
          desc: 'For office or silent installs.',
        },
      ],
      cmd: `winget install Kai-terminal --source github`,
      cmdLabel: 'Or install with one command',
      note: 'Needs WebView2, which is already on most Windows 11 PCs.',
    },
  ];

  const activeGroups = platformFilter === 'all'
    ? groups
    : groups.filter((g) => g.id === platformFilter);

  return (
    <Section id="downloads">
      <div style={{ textAlign: 'center', marginBottom: '2.75rem' }}>
        <Badge tone="green"><PackageCheck size={14} /> Free downloads</Badge>
        <h2 className="t-section-title" style={{ marginBottom: '0.75rem' }}>Download Kai</h2>
        <p className="t-section-sub" style={{ fontSize: '1.02rem' }}>
          {rel.assets.length === 0
            ? `${rel.tag} · Installers aren't published on GitHub yet. Links below resolve once the release is live — until then, build from source.`
            : `${rel.tag} · All files are on GitHub Releases. Pick your system below.`}
        </p>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', gap: '0.6rem', marginBottom: '2.5rem', flexWrap: 'wrap' }}>
        {[
          { id: 'all', label: 'All' },
          { id: 'macos', label: 'macOS' },
          { id: 'linux', label: 'Linux' },
          { id: 'windows', label: 'Windows' },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            className="t-install-tab"
            data-active={platformFilter === tab.id}
            onClick={() => setPlatformFilter(tab.id as 'all' | OsId)}
            style={{ padding: '0.55rem 1.35rem', fontSize: '0.86rem' }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="t-platform-list">
        {activeGroups.map((d) => (
          <div key={d.os} className="t-platform-box">
            <div className="t-platform-header">
              <div className="t-platform-title-wrap">
                <h3 className="t-platform-title">{d.os}</h3>
                <p className="t-platform-subtitle">{d.sub}</p>
              </div>
              <span className="t-platform-badge">{d.badge}</span>
            </div>

            <div className="t-platform-grid">
              {d.installers.map((inst) => (
                <a
                  key={inst.name}
                  className="t-dl-card"
                  href={inst.url}
                  title={`Download ${inst.name}`}
                >
                  <div className="t-dl-card-info">
                    <div className="t-dl-card-title-row">
                      <span className="t-dl-card-title">{inst.label}</span>
                      <span className="t-format-tag">{inst.format}</span>
                      {inst.recommended && (
                        <span className="t-pill" style={{ fontSize: '0.65rem', padding: '0.05rem 0.4rem' }}>Recommended</span>
                      )}
                    </div>
                    <span className="t-dl-card-file">{inst.name}</span>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{inst.desc}</span>
                  </div>
                  <div className="t-dl-card-btn">
                    <Download size={14} />
                    <span>{inst.size > 0 ? fmtSize(inst.size) : 'Download'}</span>
                  </div>
                </a>
              ))}
            </div>

            <div className="t-platform-footer">
              <div className="t-platform-cmd-wrap">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600, fontFamily: 'var(--font-mono)', marginBottom: '0.55rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <Terminal size={13} /> {d.cmdLabel}
                  </div>
                  <div className="t-mono-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', padding: '0.65rem 0.9rem' }}>
                    <code style={{ fontSize: '0.8rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.cmd}</code>
                    <CopyBtn text={d.cmd} />
                  </div>
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 260, paddingTop: '0.2rem' }}>
                <p className="t-platform-note">{d.note}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="t-panel t-verify">
        <div>
          <b>Safe and checked</b>
          <p>Every file is built cleanly and can be checked before you run it.</p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <Link to="/changelog" className="t-btn t-btn--secondary t-btn--sm">
            Changelog
          </Link>
          <a href={`${REPO_URL}/releases/tag/${rel.tag}`} target="_blank" rel="noreferrer" className="t-btn t-btn--secondary t-btn--sm">
            Release Tag <ExternalLink size={14} />
          </a>
          <a href={LATEST_RELEASE_URL} target="_blank" rel="noreferrer" className="t-btn t-btn--primary t-btn--sm">
            All Releases <ExternalLink size={14} />
          </a>
        </div>
      </div>
    </Section>
  );
}
