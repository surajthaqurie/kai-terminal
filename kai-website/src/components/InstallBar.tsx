'use client';

import { useState } from 'react';
import { CopyBtn } from './CopyBtn';

type InstallTab = { id: string; label: string; note: string; code: string };

/* One readable block per OS: short comment lines + the exact commands.
   `0.1.0` is swapped for the live release version at render time. */
function installTabs(short: string): InstallTab[] {
  const v = short;
  return [
    {
      id: 'macos',
      label: 'macOS',
      note: 'For M1–M4 Macs on macOS 12+. Open the file, drag Kai into Applications. Unsigned build: if macOS says "damaged", run xattr -cr /Applications/Kai.app, then right-click Open.',
      code: `# macOS 12 or later · M1–M4\nopen kai_${v}_aarch64.dmg\n\n# Only if macOS says "damaged" (unsigned build) — after dragging to Applications:\nxattr -cr /Applications/Kai.app`,
    },
    {
      id: 'linux',
      label: 'Linux',
      note: 'Pick .deb for Ubuntu / Debian, or .AppImage if you are unsure — it runs anywhere.',
      code: `# Ubuntu / Debian (64-bit)\nsudo dpkg -i kai_${v}_amd64.deb\n\n# Portable fallback — any distro, no install needed\nchmod +x kai_${v}_amd64.AppImage\n./kai_${v}_amd64.AppImage`,
    },
    {
      id: 'windows',
      label: 'Windows',
      note: 'For Windows 10 / 11 (64-bit). No winget package yet — download the .exe below, then run it. Needs WebView2 (preinstalled on most Windows 11 PCs).',
      code: `# Windows 10 / 11 (64-bit) — run installer after download\n.\\kai_${v}_x64-setup.exe`,
    },
    {
      id: 'source',
      label: 'From source',
      note: 'For developers: same code the installers ship. Needs Node 20+ and Rust 1.75+.',
      code: `# 1 · download the code\ngit clone https://github.com/surajthaqurie/kai-terminal.git\ncd kai-terminal\n\n# 2 · install and run the app\nnpm install\nnpm run tauri dev`,
    },
  ];
}

export function InstallBar({ short }: { short: string }) {
  const tabs = installTabs(short);
  // No OS guessing: plain tabs, starting with macOS.
  const [tab, setTab] = useState<string>('macos');
  const active = tabs.find((t) => t.id === tab) ?? tabs[0];
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
            title={`Show ${t.label} instructions`}
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
