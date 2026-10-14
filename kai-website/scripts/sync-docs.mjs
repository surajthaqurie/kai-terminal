// Syncs root repo markdown docs into src/generated/docs.json.
// Runs on predev/prebuild (alongside sync-changesets.mjs). Never fails the build.
import { readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const websiteDir = join(here, '..');
const repoRoot = join(here, '..', '..');
const outFile = join(websiteDir, 'src', 'generated', 'docs.json');

const REPO = 'surajthaqurie/kai-terminal';

const DOCS = [
  { slug: 'manual', file: 'USER_MANUAL.md', title: 'User Manual', desc: 'Complete CLI command reference — synced from GitHub.' },
  { slug: 'readme', file: 'README.md', title: 'README', desc: 'Project overview, download table and quickstart.' },
  { slug: 'install', file: 'INSTALL.md', title: 'Install', desc: 'Detailed install steps per OS.' },
  { slug: 'architecture', file: 'ARCHITECTURE.md', title: 'Architecture', desc: 'How the terminal, PTY, graph and MCP fit together.' },
  { slug: 'development', file: 'DEVELOPMENT.md', title: 'Development', desc: 'Build from source, scripts and contributor setup.' },
  { slug: 'security', file: 'SECURITY.md', title: 'Security', desc: 'Threat model, reporting and safe-handling notes.' },
  { slug: 'limitations', file: 'KNOWN_LIMITATIONS.md', title: 'Limitations', desc: 'Known gaps, platform quirks and workarounds.' },
];

function findFile(name) {
  const candidates = [join(repoRoot, name), join(websiteDir, name), join(process.cwd(), name)];
  return candidates.find((p) => existsSync(p)) ?? join(repoRoot, name);
}

function firstH1(text, fallback) {
  const m = text.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : fallback;
}

const docs = [];
for (const d of DOCS) {
  const path = findFile(d.file);
  try {
    const content = readFileSync(path, 'utf8');
    let mtime = null;
    try { mtime = statSync(path).mtime.toISOString(); } catch { /* ignore */ }
    docs.push({
      ...d,
      heading: firstH1(content, d.title),
      githubUrl: `https://github.com/${REPO}/blob/main/${d.file}`,
      rawUrl: `https://raw.githubusercontent.com/${REPO}/main/${d.file}`,
      updatedAt: mtime,
      content,
    });
  } catch (err) {
    console.warn(`[sync-docs] skip ${d.file}: ${err.message}`);
  }
}

try {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(
    outFile,
    JSON.stringify({ generatedAt: new Date().toISOString(), docs }, null, 2) + '\n',
  );
  console.log(`[sync-docs] ${docs.length} docs -> src/generated/docs.json`);
} catch (err) {
  console.warn('[sync-docs] failed to write docs.json:', err.message);
}
