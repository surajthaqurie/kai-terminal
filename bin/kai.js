#!/usr/bin/env node

import path from "path";
import fs from "fs";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve the compiled CLI bundle for both local checkouts and global
// installs (`npm i -g` / `npm link`), on Windows, Linux, and macOS.
const candidates = [
  path.resolve(__dirname, "../dist/cli/index.js"),
  path.resolve(__dirname, "../kai-terminal/dist/cli/index.js"),
];

let bundledCliPath = null;
for (const c of candidates) {
  if (fs.existsSync(c)) {
    bundledCliPath = c;
    break;
  }
}

if (!bundledCliPath) {
  console.error("[kai] Error: Compiled CLI bundle not found.");
  console.error("[kai] Searched:");
  for (const c of candidates) console.error("  - " + c);
  console.error("");
  console.error("[kai] Fix (all OS, requires Node.js 20+):");
  console.error("  1. cd to the kai-terminal repo");
  console.error("  2. npm install && npm run build:cli");
  console.error("  3. npm run setup:cli   (puts `kai` on your PATH)");
  console.error("     or: npm link        (npm global bin must be on PATH)");
  console.error("");
  console.error("[kai] After that, verify with: kai --version");
  process.exit(1);
}

try {
  const { runCli } = await import(pathToFileURL(bundledCliPath).href);
  const exitCode = await runCli(process.argv);
  process.exit(exitCode);
} catch (err) {
  console.error("[kai] Failed to start: " + (err && err.message ? err.message : String(err)));
  process.exit(1);
}
