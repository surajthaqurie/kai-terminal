#!/usr/bin/env node
// ARCH-06: the app version has one source, package.json (`npx changeset version` bumps it).
// `npm run version:sync` copies it to every other file that repeats it, so a release no longer
// edits nine files by hand. `versionSync.test.ts` fails CI if any of them is left behind.
//
//   npm run version:sync            write the version from package.json everywhere
//   npm run version:sync -- --check list what differs, change nothing (exit 1 if anything does)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces the first match of `re` (one capture group: the version) or throws. */
function replaceVersion(text, re, version, what) {
  if (!re.test(text)) throw new Error(`no version found in ${what}`);
  return text.replace(re, (whole, old) => whole.replace(old, version));
}

/** `"version": "x"` at the top of a package.json, and the root package in its lock file. */
export function syncPackageJson(text, version) {
  return replaceVersion(text, /^ {2}"version": "([^"]+)"/m, version, "package.json");
}

export function syncPackageLock(text, version) {
  const top = replaceVersion(text, /^ {2}"version": "([^"]+)"/m, version, "package-lock.json");
  return replaceVersion(
    top,
    /^ {4}"": \{\n(?: {6}.*\n)*? {6}"version": "([^"]+)"/m,
    version,
    'package-lock.json packages[""]'
  );
}

export function syncTauriConf(text, version) {
  return replaceVersion(text, /^ {2}"version": "([^"]+)"/m, version, "tauri.conf.json");
}

export function syncCargoToml(text, version) {
  return replaceVersion(
    text,
    /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/m,
    version,
    "Cargo.toml [package]"
  );
}

export function syncCargoLock(text, version) {
  return replaceVersion(
    text,
    /\[\[package\]\]\r?\nname = "kai"\r?\nversion = "([^"]+)"/,
    version,
    'Cargo.lock package "kai"'
  );
}

/** Installer names (`kai_0.2.3_x64-setup.exe`, `kai-0.2.3-1.x86_64.rpm`) and `v0.2.3` tags in docs. */
export function syncDocVersions(text, from, to) {
  if (from === to) return text;
  const v = escape(from);
  return text
    .replace(new RegExp(`\\bkai_${v}_`, "g"), `kai_${to}_`)
    .replace(new RegExp(`\\bkai-${v}-`, "g"), `kai-${to}-`)
    .replace(new RegExp(`\\bv${v}\\b`, "g"), `v${to}`);
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const check = process.argv.includes("--check");
  const file = (rel) => path.join(root, rel);
  const read = (rel) => fs.readFileSync(file(rel), "utf8");

  const version = JSON.parse(read("package.json")).version;
  if (!SEMVER.test(version)) throw new Error(`package.json version "${version}" is not x.y.z`);
  // What the docs say now: the version before this sync (tauri.conf.json follows package.json).
  const previous = JSON.parse(read("src-tauri/tauri.conf.json")).version;

  const steps = [
    ["package-lock.json", syncPackageLock],
    ["src-tauri/tauri.conf.json", syncTauriConf],
    ["src-tauri/Cargo.toml", syncCargoToml],
    ["src-tauri/Cargo.lock", syncCargoLock],
    ["kai-website/package.json", syncPackageJson],
    ["kai-website/package-lock.json", syncPackageLock],
    ["README.md", (t, v) => syncDocVersions(t, previous, v)],
    ["INSTALL.md", (t, v) => syncDocVersions(t, previous, v)],
  ];

  const changed = [];
  for (const [rel, sync] of steps) {
    if (!fs.existsSync(file(rel))) continue;
    const before = read(rel);
    const after = sync(before, version);
    if (after === before) continue;
    changed.push(rel);
    if (!check) fs.writeFileSync(file(rel), after);
  }

  if (check) {
    if (changed.length) {
      console.error(`Not at ${version}: ${changed.join(", ")}. Run: npm run version:sync`);
      process.exitCode = 1;
    } else console.log(`Every file is at ${version}.`);
    return;
  }
  console.log(
    changed.length ? `Set ${version} in: ${changed.join(", ")}` : `Every file was at ${version}.`
  );
  console.log(
    "Still by hand: a title for the release in kai-website/scripts/release-titles.json, and CHANGELOG.md (changeset)."
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
