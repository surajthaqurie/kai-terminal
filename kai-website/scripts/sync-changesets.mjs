// Builds src/generated/changesets.json and src/generated/release.json.
// Runs only on prebuild. Never fails the build.
import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = [join(here, '..', '..', '.changeset'), join(here, '..', '.changeset')]
  .find((d) => existsSync(d)) ?? join(here, '..', '..', '.changeset');
const out = join(here, '..', 'src', 'generated', 'changesets.json');
const releaseOut = join(here, '..', 'src', 'generated', 'release.json');
const dataReleaseOut = join(here, '..', 'src', 'data', 'release.json');

const entries = [];
try {
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md') || file === 'README.md') continue;
    const text = readFileSync(join(dir, file), 'utf8');
    const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!m || !m[2].trim()) continue;
    const line = m[1].split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    const fm = line?.match(/^["']?([^"':]+)["']?\s*:\s*(major|minor|patch)\s*$/);
    if (!fm) continue;
    entries.push({ file, package: fm[1].trim(), bump: fm[2], summary: m[2].trim() });
  }
} catch { /* no changesets — ship empty */ }

entries.sort((a, b) => (a.file < b.file ? -1 : 1));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), entries }, null, 2) + '\n');
console.log(`[sync-changesets] ${entries.length} entries -> src/generated/changesets.json`);

// Automatically sync latest version and release notes from package.json and CHANGELOG.md
try {
  const pkgPath = [join(here, '..', '..', 'package.json'), join(here, '..', 'package.json')].find((p) => existsSync(p));
  const pkg = pkgPath ? JSON.parse(readFileSync(pkgPath, 'utf8')) : { version: '0.1.1' };
  const version = pkg.version || '0.1.1';
  const tag = `v${version}`;

  const changelogPath = [join(here, '..', '..', 'CHANGELOG.md'), join(here, '..', 'CHANGELOG.md')].find((p) => existsSync(p));
  const releases = [];

  if (changelogPath && existsSync(changelogPath)) {
    const text = readFileSync(changelogPath, 'utf8');
    const regex = /##\s*\[?(\d+\.\d+\.\d+)\]?(?:[^\n]*)\n([\s\S]*?)(?=\n##\s*\[?\d+\.\d+\.\d+\]?|\n##\s*\[Unreleased\]|$)/g;
    let m;
    while ((m = regex.exec(text)) !== null) {
      const v = m[1];
      const relTag = `v${v}`;
      const rawLines = m[2].split('\n').map((l) => l.trim()).filter(Boolean);
      const bulletLines = rawLines.filter((l) => l.startsWith('- ') || l.startsWith('* '));
      const notes = bulletLines.slice(0, 8).map((l) => l.replace(/^[-*]\s+([a-f0-9]+:\s*)?/, '- ')).join('\n');
      const firstTitle = bulletLines[0] ? bulletLines[0].replace(/^[-*]\s+([a-f0-9]+:\s*)?/, '').split(':')[0] : `Release ${relTag}`;
      releases.push({
        tag: relTag,
        name: `Kai ${relTag} — ${firstTitle}`,
        date: new Date().toISOString(),
        url: `https://github.com/surajthaqurie/kai-terminal/releases/tag/${relTag}`,
        notes: notes || `Release ${relTag}`,
      });
    }
  }

  let existingReleases = [];
  const existingPath = [dataReleaseOut, releaseOut].find((p) => existsSync(p));
  if (existingPath) {
    try {
      const prev = JSON.parse(readFileSync(existingPath, 'utf8'));
      if (Array.isArray(prev.releases) && prev.releases.length > 0) existingReleases = prev.releases;
    } catch { /* ignore */ }
  }

  const finalReleases = releases.length > 0 ? releases : existingReleases;
  const releasePayload = JSON.stringify({ version, tag, generatedAt: new Date().toISOString(), releases: finalReleases }, null, 2) + '\n';
  writeFileSync(releaseOut, releasePayload);
  writeFileSync(dataReleaseOut, releasePayload);
  console.log(`[sync-changesets] version ${tag} (${finalReleases.length} releases) -> src/data/release.json & src/generated/release.json`);
} catch (err) {
  console.warn('[sync-changesets] failed to sync release metadata:', err.message);
}
