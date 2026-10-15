// Syncs the user manual into src/generated/docs.json.
// Runs on predev/prebuild (alongside sync-changesets.mjs). Never fails the build.
import { readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const websiteDir = join(here, '..');
const repoRoot = join(here, '..', '..');
const outGenerated = join(websiteDir, 'src', 'generated', 'docs.json');
const outData = join(websiteDir, 'src', 'data', 'docs.json');
const contentDir = join(websiteDir, 'content');

const REPO = 'surajthaqurie/kai-terminal';

const DOCS = [
  { slug: 'manual', file: 'USER_MANUAL.md', title: 'Commands', desc: 'Kai is a desktop terminal with a built-in CLI for running AI coding tools on your code. Commands outside Kai launch or quit the app. Everything else runs inside Kai.' },
  { slug: 'mcp', file: 'MCP.md', title: 'MCP', desc: 'Local MCP server: agent wiring and tool reference.' },
];

let existingDocs = [];
for (const p of [outData, outGenerated]) {
  if (existsSync(p)) {
    try {
      const prev = JSON.parse(readFileSync(p, 'utf8'));
      if (Array.isArray(prev.docs) && prev.docs.length > 0) {
        existingDocs = prev.docs;
        break;
      }
    } catch { /* ignore */ }
  }
}
const existingBySlug = new Map(existingDocs.map((d) => [d.slug, d]));

function findFile(name) {
  const candidates = [
    join(repoRoot, name),
    join(websiteDir, name),
    join(contentDir, name),
    join(websiteDir, 'docs', name),
    join(process.cwd(), name),
    join(process.cwd(), '..', name),
  ];
  return candidates.find((p) => existsSync(p));
}

function firstH1(text, fallback) {
  const m = text.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : fallback;
}

try {
  mkdirSync(contentDir, { recursive: true });
} catch { /* ignore */ }

const docs = [];
for (const d of DOCS) {
  const path = findFile(d.file);
  let content = null;
  let mtime = null;

  if (path && existsSync(path)) {
    try {
      content = readFileSync(path, 'utf8');
      try { mtime = statSync(path).mtime.toISOString(); } catch { /* ignore */ }
      // Keep a local copy in kai-website/content so isolated website builds have the source markdown
      try {
        writeFileSync(join(contentDir, d.file), content, 'utf8');
      } catch { /* ignore */ }
    } catch (err) {
      console.warn(`[sync-docs] failed to read ${path}: ${err.message}`);
    }
  }

  if (content) {
    docs.push({
      ...d,
      heading: firstH1(content, d.title),
      githubUrl: `https://github.com/${REPO}/blob/main/${d.file}`,
      rawUrl: `https://raw.githubusercontent.com/${REPO}/main/${d.file}`,
      updatedAt: mtime,
      content,
    });
  } else {
    const existing = existingBySlug.get(d.slug);
    if (existing) {
      docs.push(existing);
      console.log(`[sync-docs] preserved existing doc for ${d.slug}`);
    } else {
      console.warn(`[sync-docs] skip ${d.file}: file not found and no existing cache`);
    }
  }
}

const finalDocs = docs.length > 0 ? docs : existingDocs;
const payload = JSON.stringify({ generatedAt: new Date().toISOString(), docs: finalDocs }, null, 2) + '\n';

for (const target of [outData, outGenerated]) {
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, payload);
    console.log(`[sync-docs] ${finalDocs.length} docs -> ${target.replace(websiteDir, 'kai-website')}`);
  } catch (err) {
    console.warn(`[sync-docs] failed to write ${target}:`, err.message);
  }
}
