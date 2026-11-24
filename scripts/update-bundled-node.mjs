#!/usr/bin/env node
/* Keeps the Node.js runtime bundled into release builds current (RES-03).
 *
 * The runtime is pinned in `scripts/bundled-node-version.txt` (read by
 * `scripts/fetch-node.mjs`). This script looks up the newest release of the SAME
 * major line that nodejs.org lists as LTS and, unless told only to check, writes it
 * into that file. It never changes the major line: moving to another one (say 24 to 26)
 * is a deliberate edit of the file, after the CLI and its tests have run on it.
 *
 *   node scripts/update-bundled-node.mjs            # update the pin if a newer patch exists
 *   node scripts/update-bundled-node.mjs --check    # report only; exit 0 either way
 *
 * Prints `current=<x> latest=<y> changed=<true|false>` as its last line (the weekly
 * workflow reads it). The download itself is verified against SHASUMS256.txt by
 * fetch-node.mjs, not here.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VERSION_FILE = path.join(HERE, "bundled-node-version.txt");
const INDEX_URL = "https://nodejs.org/dist/index.json";

/** `22.12.0` / `v22.12.0` -> [22, 12, 0], or null when it is not a plain release version. */
export function parseVersion(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative, zero or positive like a sort comparator; numeric (22.9.0 < 22.10.0). */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`cannot compare "${a}" and "${b}"`);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * The newest release of major line `major` that is marked LTS in nodejs.org's index
 * (`[{ version: "v24.22.3", lts: "Krypton" | false, ... }]`), as "24.22.3"; null if none.
 * Pre-releases, odd/current-only releases and other majors are ignored.
 */
export function pickLatestLts(index, major) {
  let best = null;
  for (const entry of index) {
    if (!entry || !entry.lts) continue;
    const parsed = parseVersion(entry.version);
    if (!parsed || parsed[0] !== major) continue;
    const version = parsed.join(".");
    if (best === null || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

export function readPinnedVersion(file = VERSION_FILE) {
  const text = fs.readFileSync(file, "utf8").trim();
  if (!parseVersion(text)) throw new Error(`${file} must hold a version like 24.22.3, got "${text}"`);
  return text.replace(/^v/, "");
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const current = readPinnedVersion();
  const res = await fetch(INDEX_URL);
  if (!res.ok) throw new Error(`GET ${INDEX_URL} failed: ${res.status}`);
  const major = parseVersion(current)[0];
  const latest = pickLatestLts(await res.json(), major);
  if (!latest) throw new Error(`nodejs.org lists no LTS release of the ${major}.x line`);
  const changed = compareVersions(latest, current) > 0;
  if (changed && !checkOnly) fs.writeFileSync(VERSION_FILE, `${latest}\n`);
  console.log(`current=${current} latest=${latest} changed=${changed && !checkOnly}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
