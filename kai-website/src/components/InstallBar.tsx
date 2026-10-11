import { useState } from 'react';
import { Download } from 'lucide-react';
import { CopyBtn } from './CopyBtn';

type InstallTab = { id: string; label: string; note: string; code: string };

/* One readable block per OS: short comment lines + the exact commands.
   `0.1.0` is swapped for the live release version at render time. */
function installTabs(short: string): InstallTab[] {
  const v = short;
  return [
    {
      id: 'macos',
      label: 'Apple (macOS)',
      note: 'For Apple Silicon Macs (M1–M4) on macOS 12+. Open the file, then drag Kai into Applications.',
      code: `# Apple Silicon · macOS 12 or later\nopen Kai_${v}_aarch64.dmg`,
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
      note: 'For Windows 10 / 11 (64-bit). Prefer one click? Use the direct .exe download above.',
      code: `# Windows 10 / 11 — paste in PowerShell or CMD\nwinget install Kai-terminal --source github`,
    },
    {
      id: 'source',
      label: 'From source',
      note: 'For developers: same code the installers ship. Needs Node 20+ and Rust 1.75+.',
      code: `# 1 · download the code\ngit clone https://github.com/surajthaqurie/kai-terminal.git\ncd kai-terminal\n\n# 2 · install and run the app\nnpm install\nnpm run tauri dev`,
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
  const detected = detectTab();
  const active = tabs.find((t) => t.id === tab) ?? tabs[0];
  const commands = active.code
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
    .join('\n');

  const directDownloads: Record<string, Array<{ name: string; url: string; label: string; primary?: boolean }>> = {
    macos: [
      { name: `Kai_${short}_aarch64.dmg`, url: `https://github.com/surajthaqurie/kai-terminal/releases/download/v${short}/Kai_${short}_aarch64.dmg`, label: '.dmg (Apple Silicon)', primary: true },
    ],
    linux: [
      { name: `kai_${short}_amd64.deb`, url: `https://github.com/surajthaqurie/kai-terminal/releases/download/v${short}/kai_${short}_amd64.deb`, label: '.deb (x64)', primary: true },
      { name: `kai_${short}_amd64.AppImage`, url: `https://github.com/surajthaqurie/kai-terminal/releases/download/v${short}/kai_${short}_amd64.AppImage`, label: '.AppImage' },
    ],
    windows: [
      { name: `Kai_${short}_x64-setup.exe`, url: `https://github.com/surajthaqurie/kai-terminal/releases/download/v${short}/Kai_${short}_x64-setup.exe`, label: '.exe installer', primary: true },
      { name: `Kai_${short}_x64_en-US.msi`, url: `https://github.com/surajthaqurie/kai-terminal/releases/download/v${short}/Kai_${short}_x64_en-US.msi`, label: '.msi package' },
    ],
    source: [],
  };

  const currentDls = directDownloads[tab] ?? [];

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
            title={t.id === detected ? 'We detected this OS for you' : `Show ${t.label} instructions`}
          >
            {t.id === detected && <span className="t-detected-dot" aria-hidden="true" />}
            {t.label}
            {t.id === detected && tab !== t.id && <span className="t-sr"> (detected)</span>}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <CopyBtn text={commands} />
      </div>
      {currentDls.length > 0 && (
        <div className="t-install-direct">
          <span className="t-install-direct-label">Direct Download:</span>
          {currentDls.map((d) => (
            <a
              key={d.name}
              href={d.url}
              className={`t-btn t-btn--sm ${d.primary ? 't-btn--primary' : 't-btn--secondary'}`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', padding: '0.25rem 0.65rem', fontSize: '0.78rem' }}
            >
              <Download size={13} /> {d.label}
            </a>
          ))}
        </div>
      )}
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
