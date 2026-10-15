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
  let existingReleases = [];
  let prevVersion = null;
  let prevGeneratedAt = null;
  const existingPath = [dataReleaseOut, releaseOut].find((p) => existsSync(p));
  if (existingPath) {
    try {
      const prev = JSON.parse(readFileSync(existingPath, 'utf8'));
      if (Array.isArray(prev.releases) && prev.releases.length > 0) existingReleases = prev.releases;
      if (typeof prev.version === 'string') prevVersion = prev.version;
      if (typeof prev.generatedAt === 'string') prevGeneratedAt = prev.generatedAt;
    } catch { /* ignore */ }
  }

  const rootPkgPath = join(here, '..', '..', 'package.json');
  const sitePkgPath = join(here, '..', 'package.json');
  let version = prevVersion || '0.1.6';

  if (existsSync(rootPkgPath)) {
    try {
      const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
      if (rootPkg.version) version = rootPkg.version;
    } catch { /* ignore */ }
  } else if (existsSync(sitePkgPath)) {
    try {
      const sitePkg = JSON.parse(readFileSync(sitePkgPath, 'utf8'));
      if (sitePkg.version && sitePkg.version !== '0.1.1') version = sitePkg.version;
    } catch { /* ignore */ }
  }

  // Keep website package.json version synchronized with resolved version
  if (existsSync(sitePkgPath)) {
    try {
      const sitePkg = JSON.parse(readFileSync(sitePkgPath, 'utf8'));
      if (sitePkg.version !== version) {
        sitePkg.version = version;
        writeFileSync(sitePkgPath, JSON.stringify(sitePkg, null, 2) + '\n');
        console.log(`[sync-changesets] synced version ${version} to kai-website/package.json`);
      }
    } catch { /* ignore */ }
  }

  const tag = `v${version}`;

  const changelogPath = [
    join(here, '..', '..', 'CHANGELOG.md'),
    join(here, '..', 'CHANGELOG.md'),
    join(here, '..', 'content', 'CHANGELOG.md'),
  ].find((p) => existsSync(p));
  const releases = [];
  const existingByTag = new Map(existingReleases.map((er) => [er.tag, er]));
  const now = new Date().toISOString();

  if (changelogPath && existsSync(changelogPath)) {
    const text = readFileSync(changelogPath, 'utf8');
    const regex = /##\s*\[?(\d+\.\d+\.\d+)\]?(?:[^\n]*)\n([\s\S]*?)(?=\n##\s*\[?\d+\.\d+\.\d+\]?|\n##\s*\[Unreleased\]|$)/g;
    let m;
    // Dedupe by tag: same release -> old entry is removed and replaced
    // with the freshly parsed notes (no duplicates). New releases are
    // appended without touching the other tags.
    const byTag = new Map();
    while ((m = regex.exec(text)) !== null) {
      const v = m[1];
      const relTag = `v${v}`;
      const rawLines = m[2].split('\n').map((l) => l.trim()).filter(Boolean);
      const bulletLines = rawLines.filter((l) => l.startsWith('- ') || l.startsWith('* '));
      const notes = bulletLines.slice(0, 8).map((l) => l.replace(/^[-*]\s+([a-f0-9]+:\s*)?/, '- ')).join('\n');
      const firstTitle = bulletLines[0] ? bulletLines[0].replace(/^[-*]\s+([a-f0-9]+:\s*)?/, '').split(':')[0] : `Release ${relTag}`;
      const name = `Kai ${relTag} — ${firstTitle}`;
      const prev = existingByTag.get(relTag);
      // Same tag + identical content -> keep old date so history is stable.
      // Same tag + changed notes/name -> refresh date so the update is visible.
      // New tag -> stamp now.
      const unchanged = prev && prev.notes === (notes || `Release ${relTag}`) && prev.name === name;
      byTag.set(relTag, {
        tag: relTag,
        name,
        date: unchanged ? prev.date : now,
        url: `https://github.com/surajthaqurie/kai-terminal/releases/tag/${relTag}`,
        notes: notes || `Release ${relTag}`,
      });
    }
    releases.push(...byTag.values());
    // Keep any previously-known tags that are no longer in CHANGELOG
    // (new releases must never delete old ones).
    for (const prev of existingReleases) {
      if (!byTag.has(prev.tag)) releases.push(prev);
    }
    // Newest version first for stable display order.
    releases.sort((a, b) => {
      const pa = a.tag.slice(1).split('.').map(Number);
      const pb = b.tag.slice(1).split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
      }
      return 0;
    });
  }

  const finalReleases = releases.length > 0 ? releases : existingReleases;
  // Only bump generatedAt when version or release content actually changed,
  // so every prebuild doesn't dirty the tracked data file. Same-tag edits
  // still surface via the per-release date refresh above.
  const contentChanged =
    prevVersion !== version ||
    JSON.stringify(finalReleases) !== JSON.stringify(existingReleases);
  const generatedAt = contentChanged ? now : (prevGeneratedAt || now);
  const releasePayload = JSON.stringify({ version, tag, generatedAt, releases: finalReleases }, null, 2) + '\n';
  writeFileSync(releaseOut, releasePayload);
  writeFileSync(dataReleaseOut, releasePayload);
  console.log(`[sync-changesets] version ${tag} (${finalReleases.length} releases) -> src/data/release.json & src/generated/release.json`);
} catch (err) {
  console.warn('[sync-changesets] failed to sync release metadata:', err.message);
}
