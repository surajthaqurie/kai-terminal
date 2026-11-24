#!/usr/bin/env node
/* Fails when the built frontend (dist/assets) outgrows its size budget (RES-04).
 *
 *   npm run build && node scripts/check-bundle-budget.mjs
 *
 * Sizes are gzip (default level) of each JS/CSS file; fonts and images are not counted (already
 * compressed, and they do not grow with code). `scripts/bundle-budget.json` holds the limits in
 * kB. They sit ~8% above the size measured when they were set, so ordinary work passes and a
 * dependency that adds tens of kB does not. To raise one on purpose, edit the JSON in the
 * same change and say why in the commit message.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/** gzip kB of every `.js` / `.css` file in `dir`: `[{ name, kb }]`. */
export function measureAssets(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(js|css)$/.test(f))
    .map((name) => ({ name, kb: zlib.gzipSync(fs.readFileSync(path.join(dir, name))).length / 1024 }));
}

/**
 * Compares measurements with `budget` = `{ entries: { "App": kB, ... }, totalJs: kB, totalCss: kB }`.
 * An entry key matches the hashed chunk `<key>-<hash>.js`. Returns `{ rows, failures }`.
 */
export function checkBudget(assets, budget) {
  const rows = [];
  const failures = [];
  const add = (label, kb, limit) => {
    rows.push({ label, kb, limit });
    if (kb > limit) failures.push(`${label}: ${kb.toFixed(1)} kB gzip > budget ${limit} kB`);
  };
  for (const [key, limit] of Object.entries(budget.entries ?? {})) {
    const match = assets.find((a) => a.name.startsWith(`${key}-`) && a.name.endsWith(".js"));
    if (!match) failures.push(`${key}: no built chunk named ${key}-*.js (renamed? update the budget)`);
    else add(match.name, match.kb, limit);
  }
  const sum = (ext) => assets.filter((a) => a.name.endsWith(ext)).reduce((n, a) => n + a.kb, 0);
  if (budget.totalJs != null) add("all JavaScript", sum(".js"), budget.totalJs);
  if (budget.totalCss != null) add("all CSS", sum(".css"), budget.totalCss);
  return { rows, failures };
}

function main() {
  const dir = path.join(ROOT, "dist", "assets");
  if (!fs.existsSync(dir)) {
    console.error("dist/assets not found: run `npm run build` first.");
    process.exit(2);
  }
  const budget = JSON.parse(fs.readFileSync(path.join(HERE, "bundle-budget.json"), "utf8"));
  const { rows, failures } = checkBudget(measureAssets(dir), budget);
  for (const r of rows) {
    console.log(`${r.label.padEnd(36)} ${r.kb.toFixed(1).padStart(7)} kB gzip   (budget ${r.limit})`);
  }
  if (failures.length) {
    console.error(`\nBundle budget exceeded:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("\nBundle budget OK.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
