#!/usr/bin/env node
/* Downloads the official Node.js binary for THIS machine's OS and CPU into
 * `src-tauri/resources/node/`, so a release build can ship its own Node.js and
 * the bundled `kai` CLI runs on a machine with no Node installed.
 *
 * Usage (release builds only; see .github/workflows/release.yml):
 *   node scripts/fetch-node.mjs
 *
 * The archive is checked against the SHASUMS256.txt published beside it before
 * anything is unpacked, and only the `node` executable is kept. Set
 * KAI_NODE_VERSION to use another release (the CLI targets Node 20 and newer).
 *
 * Nothing here runs in a normal dev checkout or in CI tests: the Tauri config
 * that adds the binary to the bundle is `tauri.bundled-node.conf.json`, passed
 * only by the release workflow.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = (process.env.KAI_NODE_VERSION || "22.12.0").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) {
  throw new Error(`KAI_NODE_VERSION must look like 22.12.0, got "${VERSION}"`);
}

const PLATFORMS = { win32: "win", darwin: "darwin", linux: "linux" };
const ARCHES = { x64: "x64", arm64: "arm64" };
const platform = PLATFORMS[process.platform];
const arch = ARCHES[process.arch];
if (!platform || !arch) {
  throw new Error(`No Node.js build for ${process.platform}/${process.arch}`);
}

const isWin = platform === "win";
const base = `node-v${VERSION}-${platform}-${arch}`;
const archive = `${base}.${isWin ? "zip" : "tar.gz"}`;
const root = `https://nodejs.org/dist/v${VERSION}`;
const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "resources", "node");
const exeName = isWin ? "node.exe" : "node";

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const sums = (await download(`${root}/SHASUMS256.txt`)).toString("utf8");
const line = sums.split("\n").find((l) => l.trim().endsWith(`  ${archive}`));
if (!line) throw new Error(`${archive} is not listed in SHASUMS256.txt`);
const expected = line.trim().split(/\s+/)[0].toLowerCase();

console.log(`Downloading ${archive} ...`);
const bytes = await download(`${root}/${archive}`);
const actual = createHash("sha256").update(bytes).digest("hex");
if (actual !== expected) {
  throw new Error(`Checksum mismatch for ${archive}: expected ${expected}, got ${actual}`);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "kai-node-"));
try {
  const file = path.join(work, archive);
  fs.writeFileSync(file, bytes);
  if (isWin) {
    // A bare `tar` on a Windows runner may be GNU tar (no zip support), so use the
    // bsdtar that ships with Windows (System32\tar.exe), which reads zips. If that
    // is missing or fails, fall back to .NET's ZipFile. `Expand-Archive` is avoided:
    // on the windows-arm64 runner it hits a .NET overload error that it reports as a
    // non-terminating error, so the process still exits 0 with nothing extracted.
    const sysTar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    let extracted = false;
    if (fs.existsSync(sysTar)) {
      try {
        execFileSync(sysTar, ["-xf", file, "-C", work], { stdio: "inherit" });
        extracted = true;
      } catch (err) {
        console.warn(`System32 tar could not unpack the zip (${err.message}); falling back to .NET`);
      }
    }
    if (!extracted) {
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
            `[System.IO.Compression.ZipFile]::ExtractToDirectory('${file}', '${work}')`,
        ],
        { stdio: "inherit" }
      );
    }
  } else {
    execFileSync("tar", ["-xzf", file, "-C", work, `${base}/bin/node`], { stdio: "inherit" });
  }
  const unpacked = path.join(work, base, isWin ? exeName : path.join("bin", exeName));
  if (!fs.existsSync(unpacked)) {
    throw new Error(`${exeName} was not found after unpacking ${archive} (expected ${unpacked})`);
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, exeName);
  fs.copyFileSync(unpacked, target);
  if (!isWin) fs.chmodSync(target, 0o755);
  console.log(`Bundled Node.js v${VERSION} (${platform}-${arch}) -> ${target}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
