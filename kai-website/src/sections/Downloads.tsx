import { useState } from 'react';
import {
  Apple,
  AppWindow,
  CheckCircle2,
  Download,
  ExternalLink,
  HardDrive,
  PackageCheck,
  Terminal,
} from 'lucide-react';
import { Badge, Section } from '../components/ui';
import { CopyBtn } from '../components/CopyBtn';
import { fmtSize } from '../lib/format';
import { LATEST_RELEASE_URL, REPO_URL } from '../data/site';
import type { LatestRelease } from '../hooks/useRepo';

type PlatformInstaller = {
  name: string;
  url: string;
  size: number;
  label: string;
  format: string;
  arch: string;
  recommended?: boolean;
};

type PlatformSubgroup = {
  title: string;
  installers: PlatformInstaller[];
};

type PlatformGroup = {
  id: 'apple' | 'linux' | 'windows';
  os: string;
  badge: string;
  icon: JSX.Element;
  sub: string;
  description: string;
  subgroups: PlatformSubgroup[];
  cmd: string;
  cmdLabel: string;
  notes: string;
  requirements: string[];
};

export function Downloads({ rel }: { rel: LatestRelease }) {
  const [platformFilter, setPlatformFilter] = useState<'all' | 'apple' | 'linux' | 'windows'>('all');

  const groups: PlatformGroup[] = [
    {
      id: 'apple',
      os: 'Apple (macOS)',
      badge: 'Apple Silicon · ARM64',
      icon: <Apple size={24} color="var(--accent-cyan-fg)" />,
      sub: 'macOS 12 Monterey or later · Native M1, M2, M3 & M4',
      description: 'Native ARM64 binary with zero Rosetta 2 translation overhead. Built with GPU Metal canvas rendering and native POSIX pseudoterminal streaming.',
      subgroups: [
        {
          title: 'Apple Silicon (M1–M4 / ARM64)',
          installers: [
            {
              name: `Kai_${rel.short}_aarch64.dmg`,
              url: rel.asset((n) => n.toLowerCase().endsWith('.dmg'), `Kai_0.1.0_aarch64.dmg`),
              size: rel.assets.find((a) => a.name.toLowerCase().endsWith('.dmg'))?.size ?? 0,
              label: 'Disk Image Installer (.dmg)',
              format: '.dmg',
              arch: 'ARM64',
              recommended: true,
            },
          ],
        },
      ],
      cmd: `open Kai_${rel.short}_aarch64.dmg`,
      cmdLabel: 'Mount disk image & drag Kai.app to /Applications',
      notes: 'Unsigned build notice: On first launch, right-click Kai.app > Open, or run: xattr -cr /Applications/Kai.app',
      requirements: [
        'Apple Silicon M1, M2, M3, or M4',
        'macOS 12.0 (Monterey) or later',
        'Hardware-accelerated Metal GPU',
      ],
    },
    {
      id: 'linux',
      os: 'Linux',
      badge: 'x86_64 & ARM64',
      icon: <Terminal size={24} color="var(--accent-green-fg)" />,
      sub: 'Ubuntu 22.04+, Debian 12+, Fedora, Arch, OpenSUSE · glibc ≥ 2.35',
      description: 'Direct POSIX pseudoterminal integration. Ships both Debian/Ubuntu packages and universal portable AppImages without external runtime dependencies.',
      subgroups: [
        {
          title: 'x86_64 Architecture (64-bit Intel / AMD)',
          installers: [
            {
              name: `kai_${rel.short}_amd64.deb`,
              url: rel.asset((n) => n.toLowerCase().includes('amd64') && n.toLowerCase().endsWith('.deb'), 'kai_0.1.0_amd64.deb'),
              size: rel.assets.find((a) => a.name.toLowerCase().includes('amd64') && a.name.toLowerCase().endsWith('.deb'))?.size ?? 0,
              label: 'Debian / Ubuntu Package',
              format: '.deb',
              arch: 'x86_64',
              recommended: true,
            },
            {
              name: `kai_${rel.short}_amd64.AppImage`,
              url: rel.asset((n) => n.toLowerCase().includes('amd64') && n.toLowerCase().endsWith('.appimage'), 'kai_0.1.0_amd64.AppImage'),
              size: rel.assets.find((a) => a.name.toLowerCase().includes('amd64') && a.name.toLowerCase().endsWith('.appimage'))?.size ?? 0,
              label: 'Portable Standalone Executable',
              format: '.AppImage',
              arch: 'x86_64',
            },
          ],
        },
        {
          title: 'ARM64 Architecture (aarch64)',
          installers: [
            {
              name: `kai_${rel.short}_arm64.deb`,
              url: rel.asset((n) => n.toLowerCase().includes('arm64') && n.toLowerCase().endsWith('.deb'), 'kai_0.1.0_arm64.deb'),
              size: rel.assets.find((a) => a.name.toLowerCase().includes('arm64') && a.name.toLowerCase().endsWith('.deb'))?.size ?? 0,
              label: 'ARM64 Debian / Ubuntu Package',
              format: '.deb',
              arch: 'ARM64',
            },
            {
              name: `kai_${rel.short}_arm64.AppImage`,
              url: rel.asset((n) => n.toLowerCase().includes('arm64') && n.toLowerCase().endsWith('.appimage'), 'kai_0.1.0_arm64.AppImage'),
              size: rel.assets.find((a) => a.name.toLowerCase().includes('arm64') && a.name.toLowerCase().endsWith('.appimage'))?.size ?? 0,
              label: 'ARM64 Portable Executable',
              format: '.AppImage',
              arch: 'ARM64',
            },
          ],
        },
      ],
      cmd: `sudo dpkg -i kai_${rel.short}_amd64.deb`,
      cmdLabel: 'Install via dpkg (or chmod +x *.AppImage)',
      notes: 'AppImage portability: Requires FUSE 2 (sudo apt install libfuse2 on Ubuntu 22.04+) or launch with --appimage-extract-and-run.',
      requirements: [
        'glibc ≥ 2.35 (Ubuntu 22.04+, Debian 12+)',
        'libwebkit2gtk-4.1 (standard on GNOME/KDE)',
        'FUSE 2 runtime for portable AppImage',
      ],
    },
    {
      id: 'windows',
      os: 'Windows',
      badge: '64-bit · ConPTY',
      icon: <AppWindow size={24} color="var(--accent-purple-fg)" />,
      sub: 'Windows 10 (version 1809+) & Windows 11 · 64-bit (x64)',
      description: 'Native Windows ConPTY console integration with high-frequency ANSI throughput, PowerShell 7, Command Prompt, and WSL2 support.',
      subgroups: [
        {
          title: '64-bit Installers (x86_64)',
          installers: [
            {
              name: `Kai_${rel.short}_x64-setup.exe`,
              url: rel.asset((n) => n.toLowerCase().endsWith('setup.exe'), `Kai_0.1.0_x64-setup.exe`),
              size: rel.assets.find((a) => a.name.toLowerCase().endsWith('setup.exe'))?.size ?? 0,
              label: 'Setup Installer (.exe)',
              format: '.exe',
              arch: 'x64',
              recommended: true,
            },
            {
              name: `Kai_${rel.short}_x64_en-US.msi`,
              url: rel.asset((n) => n.toLowerCase().endsWith('.msi'), `Kai_0.1.0_x64_en-US.msi`),
              size: rel.assets.find((a) => a.name.toLowerCase().endsWith('.msi'))?.size ?? 0,
              label: 'Windows Installer Package (.msi)',
              format: '.msi',
              arch: 'x64',
            },
          ],
        },
      ],
      cmd: `winget install Kai-terminal --source github`,
      cmdLabel: 'Install via Windows Package Manager (or run .exe)',
      notes: 'WebView2 dependency: Requires Microsoft Edge WebView2 runtime (pre-installed on Windows 11 and modern Windows 10 updates).',
      requirements: [
        'Windows 10 Build 17763 (1809) or Windows 11',
        'Microsoft Edge WebView2 Runtime',
        '64-bit (x86_64) processor',
      ],
    },
  ];

  const activeGroups = platformFilter === 'all'
    ? groups
    : groups.filter((g) => g.id === platformFilter);

  return (
    <Section id="downloads">
      <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
        <Badge tone="green"><PackageCheck size={14} /> Official Release Builds · GitHub Actions</Badge>
        <h2 className="t-section-title">Releases &amp; Direct Downloads</h2>
        <p className="t-section-sub">
          {`${rel.tag} · Structured group-wise releases for Apple (macOS), Linux & Windows`}
        </p>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', gap: '0.5rem', marginBottom: '2.5rem', flexWrap: 'wrap' }}>
        {[
          { id: 'all', label: 'All Platforms (Grouped)' },
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

      <div className="t-grid-3" style={{ marginBottom: '2.5rem' }}>
        {activeGroups.map((d) => (
          <div key={d.os} className="t-platform-card" data-platform={d.id}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.65rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                {d.icon}
                <div>
                  <h3 style={{ margin: 0, fontSize: '1.15rem' }}>{d.os}</h3>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>{d.badge}</span>
                </div>
              </div>
            </div>

            <p style={{ margin: '0 0 1rem', fontSize: '0.83rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {d.sub}
            </p>

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              {d.subgroups.map((sg) => (
                <div key={sg.title} className="t-platform-subgroup">
                  <div className="t-platform-subgroup-title">
                    <HardDrive size={13} /> {sg.title}
                  </div>
                  <div>
                    {sg.installers.map((inst) => (
                      <a
                        key={inst.name}
                        className="t-dl-row"
                        href={inst.url}
                        title={`Download ${inst.name}`}
                      >
                        <div className="t-dl-row-main">
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                            <span className="t-dl-row-title">{inst.label}</span>
                            <span className="t-format-tag">{inst.format}</span>
                            {inst.recommended && (
                              <span className="t-pill" style={{ fontSize: '0.65rem', padding: '0.05rem 0.4rem' }}>Recommended</span>
                            )}
                          </div>
                          <span className="t-dl-row-file">{inst.name}</span>
                        </div>
                        <div className="t-dl-row-action">
                          {inst.size > 0 && <span>{fmtSize(inst.size)}</span>}
                          <Download size={15} />
                        </div>
                      </a>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: '1.25rem' }}>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', marginBottom: '0.35rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <Terminal size={12} /> {d.cmdLabel}
              </div>
              <div className="t-mono-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', padding: '0.5rem 0.75rem' }}>
                <code style={{ fontSize: '0.76rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.cmd}</code>
                <CopyBtn text={d.cmd} />
              </div>
            </div>

            <div style={{ marginTop: '0.85rem', paddingTop: '0.85rem', borderTop: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', marginBottom: '0.35rem' }}>
                System Requirements:
              </div>
              <ul className="t-req-list">
                {d.requirements.map((r, i) => (
                  <li key={i}>
                    <CheckCircle2 size={12} color="var(--accent-green-fg)" />
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
              <p className="t-micro" style={{ marginTop: '0.65rem', marginBottom: 0, lineHeight: 1.45 }}>
                {d.notes}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="t-panel t-verify">
        <div>
          <b>SHA-256 Checksums &amp; Release Verification</b>
          <p>Every installer is compiled on clean GitHub Actions runners. Review checksums and commit signatures before executing.</p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <a href="/changelog" className="t-btn t-btn--secondary t-btn--sm">
            Changelog
          </a>
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
