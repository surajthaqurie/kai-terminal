'use client';

import { useState } from 'react';
import { Download, ExternalLink, PackageCheck, Terminal } from 'lucide-react';
import { Badge, Section } from '../components/ui';
import { Link } from '../router';
import { CopyBtn } from '../components/CopyBtn';
import { fmtSize } from '../lib/format';
import type { OsId } from '../lib/os';
import { LATEST_RELEASE_URL, REPO_URL } from '../data/site';
import type { SerializableRelease } from '../lib/release';
import { assetUrl } from '../lib/release';
import { useResolvedRelease } from '../hooks/useRepo';

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

export function Downloads({ rel: serverRel, showHead = true }: { rel: SerializableRelease; showHead?: boolean }) {
  const rel = useResolvedRelease(serverRel);
  // Match each file by its exact architecture suffix: several assets share an
  // extension (`_arm64-setup.exe` and `_x64-setup.exe`, two `.dmg`s, two `.rpm`s),
  // and the first one GitHub lists is not necessarily the one a card means.
  const file = (fileName: string) => {
    const lower = fileName.toLowerCase();
    const asset = rel.assets.find((a) => a.name.toLowerCase() === lower);
    return {
      name: fileName,
      url: assetUrl(rel, (n) => n.toLowerCase() === lower, fileName),
      size: asset?.size ?? 0,
    };
  };
  // Show everything by default — the user picks, we don't guess.
  const [platformFilter, setPlatformFilter] = useState<'all' | OsId>('all');

  const groups: PlatformGroup[] = [
    {
      id: 'macos',
      os: 'macOS',
      badge: 'Apple Silicon & Intel',
      sub: 'macOS 12 or newer · M1–M4 and Intel Macs',
      installers: [
        {
          ...file(`kai_${rel.short}_aarch64.dmg`),
          label: 'Mac Installer',
          format: '.dmg',
          arch: 'ARM64',
          desc: 'For M1, M2, M3 and M4 Macs. Open the file and drag Kai to Applications. Unsigned build — see Gatekeeper fix below.',
          recommended: true,
        },
        {
          ...file(`kai_${rel.short}_x64.dmg`),
          label: 'Mac Installer (Intel)',
          format: '.dmg',
          arch: 'x86_64',
          desc: 'For Intel Macs. Same steps as above.',
        },
      ],
      cmd: `open kai_${rel.short}_aarch64.dmg`,
      cmdLabel: 'Open and install',
      note: 'Unsigned build: if macOS says "kai is damaged", run xattr -cr /Applications/Kai.app, then right-click Kai > Open.',
    },
    {
      id: 'linux',
      os: 'Linux',
      badge: 'x86_64 & ARM64',
      sub: 'Ubuntu, Debian, Fedora and more',
      installers: [
        {
          ...file(`kai_${rel.short}_amd64.deb`),
          label: 'Linux Installer',
          format: '.deb',
          arch: 'x86_64',
          desc: 'Best for Ubuntu and Debian. Double-click to install.',
          recommended: true,
        },
        {
          ...file(`kai-${rel.short}-1.x86_64.rpm`),
          label: 'Linux Installer (RPM)',
          format: '.rpm',
          arch: 'x86_64',
          desc: 'For Fedora, RHEL and openSUSE: sudo dnf install ./kai-*.rpm',
        },
        {
          ...file(`kai_${rel.short}_amd64.AppImage`),
          label: 'Portable App',
          format: '.AppImage',
          arch: 'x86_64',
          desc: 'Works on most Linux systems. No install needed.',
        },
        {
          ...file(`kai_${rel.short}_arm64.deb`),
          label: 'Linux Installer (ARM)',
          format: '.deb',
          arch: 'ARM64',
          desc: 'For ARM computers like Raspberry Pi.',
        },
        {
          ...file(`kai-${rel.short}-1.aarch64.rpm`),
          label: 'Linux Installer (ARM, RPM)',
          format: '.rpm',
          arch: 'ARM64',
          desc: 'RPM package for ARM systems.',
        },
        {
          // Published as `kai_<v>_aarch64.AppImage` (the .deb is `_arm64`).
          ...file(`kai_${rel.short}_aarch64.AppImage`),
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
      badge: 'x64 & ARM64 · ConPTY',
      sub: 'Windows 10 and 11 · 64-bit, and Windows 11 on ARM',
      installers: [
        {
          ...file(`kai_${rel.short}_x64-setup.exe`),
          label: 'Windows Setup',
          format: '.exe',
          arch: 'x64',
          desc: 'Normal setup. Double-click and follow the steps.',
          recommended: true,
        },
        {
          ...file(`kai_${rel.short}_x64_en-US.msi`),
          label: 'Windows Installer',
          format: '.msi',
          arch: 'x64',
          desc: 'For office or silent installs.',
        },
        {
          ...file(`kai_${rel.short}_arm64-setup.exe`),
          label: 'Windows Setup (ARM)',
          format: '.exe',
          arch: 'ARM64',
          desc: 'For Windows 11 on ARM PCs (Snapdragon).',
        },
      ],
      cmd: `kai_${rel.short}_x64-setup.exe`,
      cmdLabel: 'File to download',
      note: 'No winget package yet — download the .exe above and double-click it. Needs WebView2, which is already on most Windows 11 PCs.',
    },
  ];

  const activeGroups = platformFilter === 'all'
    ? groups
    : groups.filter((g) => g.id === platformFilter);

  return (
    <Section id="downloads">
      {showHead && (
      <div style={{ textAlign: 'center', marginBottom: '2.75rem' }}>
        <Badge tone="green"><PackageCheck size={14} /> Free downloads</Badge>
        <h2 className="t-section-title" style={{ marginBottom: '0.75rem' }}>Download Kai</h2>
        <p className="t-section-sub" style={{ fontSize: '1.02rem' }}>
          {rel.assets.length === 0
            ? `${rel.tag} · Installers aren't published on GitHub yet. Links below resolve once the release is live — until then, build from source.`
            : `${rel.tag} · All files are on GitHub Releases. Pick your system below.`}
        </p>
      </div>
      )}

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
