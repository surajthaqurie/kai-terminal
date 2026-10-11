import { useState } from 'react';
import { CopyBtn } from './CopyBtn';

type InstallTab = { id: string; label: string; note: string; code: string };

/* One readable block per OS: short comment lines + the exact commands.
   `0.1.0` is swapped for the live release version at render time. */
function installTabs(short: string): InstallTab[] {
  const v = short;
  return [
    {
      id: 'windows',
      label: 'Windows',
      note: 'Windows 10 / 11 · 64-bit — or grab the .exe / .msi below',
      code: `# Windows 10 / 11\nwinget install Kai-terminal --source github`,
    },
    {
      id: 'linux',
      label: 'Linux',
      note: '.deb for Debian / Ubuntu, .AppImage runs on any distro',
      code: `# Debian / Ubuntu (64-bit)\nsudo dpkg -i kai_${v}_amd64.deb\n\n# Portable — any distro\nchmod +x kai_${v}_amd64.AppImage\n./kai_${v}_amd64.AppImage`,
    },
    {
      id: 'macos',
      label: 'macOS',
      note: 'Apple Silicon · macOS 12 or later — then drag Kai to /Applications',
      code: `# Apple Silicon · macOS 12+\nopen Kai_${v}_aarch64.dmg`,
    },
    {
      id: 'source',
      label: 'From source',
      note: 'Needs Node 20+ and Rust 1.75+ — same code the installers ship',
      code: `# 1 · get the code\ngit clone https://github.com/surajthaqurie/kai-terminal.git\ncd kai-terminal\n\n# 2 · install and run\nnpm install\nnpm run tauri dev`,
    },
  ];
}

function detectTab(): string {
  if (typeof navigator === 'undefined') return 'linux';
  const p = (navigator.platform ?? '').toLowerCase();
  const ua = navigator.userAgent.toLowerCase();
  if (p.includes('mac') || ua.includes('mac')) return 'macos';
  if (p.includes('win') || ua.includes('windows')) return 'windows';
  return 'linux';
}

export function InstallBar({ short }: { short: string }) {
  const tabs = installTabs(short);
  const [tab, setTab] = useState<string>(detectTab);
  const active = tabs.find((t) => t.id === tab) ?? tabs[1];
  const commands = active.code
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
    .join('\n');

  return (
    <div className="t-install" role="region" aria-label="Install Kai">
      <div className="t-install-tabs" role="tablist" aria-label="Install instructions by platform">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className="t-install-tab"
            data-active={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <CopyBtn text={commands} />
      </div>
      <pre className="t-install-code"><code>{active.code.split('\n').map((line, i) => {
        const trimmed = line.trim();
        if (trimmed === '') return <span key={i} className="t-code-line" aria-hidden="true">&nbsp;</span>;
        if (trimmed.startsWith('#')) return <span key={i} className="t-code-line t-code-comment">{line}</span>;
        return <span key={i} className="t-code-line"><span className="t-code-prompt">$</span>{line}</span>;
      })}</code></pre>
      <div className="t-install-note">{active.note}</div>
    </div>
  );
}
