// Syncs pending changesets into src/generated/changesets.json so the website
// can render an "Unreleased" changelog block. Runs as `prebuild` (and `predev`)
// so dev and Vercel builds always embed the current .changeset state.
// Never fails the build: on any error it writes an empty entry list.
import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  join(here, '..', '..', '.changeset'),
  join(here, '..', '.changeset'),
  join(process.cwd(), '.changeset'),
  join(process.cwd(), '..', '.changeset'),
];
const changesetDir = candidates.find((d) => existsSync(d)) || join(here, '..', '..', '.changeset');
const outFile = join(here, '..', 'src', 'generated', 'changesets.json');

function parseEntry(file, text) {
  // Frontmatter shape: ---\n"package-name": patch\n---\nsummary…
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return null;
  const head = m[1];
  const summary = m[2].trim();
  const line = head
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  if (!line) return null;
  const fm = line.match(/^["']?([^"':]+)["']?\s*:\s*(major|minor|patch)\s*$/);
  if (!fm) return null;
  if (!summary) return null;
  return { file, package: fm[1].trim(), bump: fm[2], summary };
}

let entries = [];
try {
  for (const file of readdirSync(changesetDir)) {
    if (!file.endsWith('.md') || file === 'README.md') continue;
    try {
      const parsed = parseEntry(file, readFileSync(join(changesetDir, file), 'utf8'));
      if (parsed) entries.push(parsed);
    } catch {
      // Skip one unreadable file, keep the rest.
    }
  }
} catch {
  // No .changeset dir (or unreadable) — ship an empty list.
}

entries.sort((a, b) => (a.file < b.file ? -1 : 1));

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), entries }, null, 2) + '\n');
console.log(`[sync-changesets] wrote ${entries.length} pending entr${entries.length === 1 ? 'y' : 'ies'} -> src/generated/changesets.json`);
