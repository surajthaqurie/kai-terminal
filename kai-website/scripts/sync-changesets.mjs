// Builds src/generated/changesets.json from ../.changeset/*.md.
// Runs only on prebuild. Never fails the build.
import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = [join(here, '..', '..', '.changeset'), join(here, '..', '.changeset')]
  .find((d) => existsSync(d)) ?? join(here, '..', '..', '.changeset');
const out = join(here, '..', 'src', 'generated', 'changesets.json');

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
