#!/usr/bin/env node
/**
 * Software bill of materials for a release (CI-03): what the installers ship, in CycloneDX JSON.
 *
 *   node scripts/generate-sbom.mjs <out-dir> [version]
 *
 * Writes `kai_<version>_sbom-npm.cdx.json`: the JavaScript packages in the app and the `kai` CLI,
 * plus the Node.js runtime the installers bundle. (The Rust crates are listed separately by
 * `cargo cyclonedx`, see release.yml.) The file name carries `_<version>_` so the release's
 * own-version checks accept it.
 *
 * Starts from `npm sbom --omit dev` (runtime dependencies), then adds the devDependencies the CLI
 * build bundles anyway (`noExternal` in vite.cli.config.ts, e.g. gpt-tokenizer: bundled, so it is
 * a devDependency to keep `npm install kai-terminal` from downloading it twice) together with
 * everything they depend on. Leaving those out would hide code that ships.
 */
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** devDependencies that the CLI build bundles into what ships. */
export function bundledDevPackages(viteCliConfig, devDependencies) {
  const block = /noExternal\s*:\s*\[([^\]]*)\]/.exec(viteCliConfig)?.[1] ?? "";
  const named = [...block.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  return named.filter((name) => Object.hasOwn(devDependencies ?? {}, name));
}

/**
 * Adds `names` (and every component they depend on, per the full SBOM's dependency graph) from
 * `full` to `base`. Returns a new BOM; neither input is changed.
 */
export function withComponents(base, full, names) {
  const byRef = new Map(full.components.map((c) => [c["bom-ref"], c]));
  const edges = new Map((full.dependencies ?? []).map((d) => [d.ref, d.dependsOn ?? []]));
  const have = new Set(base.components.map((c) => c["bom-ref"]));
  const add = [];
  const queue = full.components.filter((c) => names.includes(c.name)).map((c) => c["bom-ref"]);
  const missing = names.filter((n) => !full.components.some((c) => c.name === n));
  if (missing.length) throw new Error(`Not in the lockfile SBOM: ${missing.join(", ")}`);
  while (queue.length) {
    const ref = queue.shift();
    if (have.has(ref)) continue;
    have.add(ref);
    const component = byRef.get(ref);
    if (component) add.push(component);
    queue.push(...(edges.get(ref) ?? []));
  }
  const refs = new Set([...have]);
  const dependencies = [
    ...(base.dependencies ?? []),
    ...(full.dependencies ?? []).filter(
      (d) => add.some((c) => c["bom-ref"] === d.ref) && refs.has(d.ref)
    ),
  ];
  return { ...base, components: [...base.components, ...add], dependencies };
}

/** The Node.js runtime the installers carry (scripts/bundled-node-version.txt). */
export function nodeRuntimeComponent(version) {
  return {
    "bom-ref": `pkg:generic/nodejs@${version}`,
    type: "application",
    name: "node",
    version,
    description: "Node.js runtime bundled with the installers to run the kai CLI",
    purl: `pkg:generic/nodejs@${version}?download_url=https://nodejs.org/dist/v${version}/`,
    externalReferences: [{ type: "website", url: "https://nodejs.org/" }],
  };
}

function npmSbom(omitDev) {
  const args = ["sbom", "--sbom-format", "cyclonedx", "--package-lock-only"];
  if (omitDev) args.push("--omit", "dev");
  // One command string: every argument above is a fixed literal, and on Windows npm is a .cmd
  // shim that only a shell can start.
  const out = execSync(`npm ${args.join(" ")}`, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function main() {
  const outDir = resolve(process.argv[2] ?? "sbom");
  const version = process.argv[3] ?? pkg.version;
  const bundled = bundledDevPackages(
    readFileSync(join(root, "vite.cli.config.ts"), "utf8"),
    pkg.devDependencies
  );
  let bom = npmSbom(true);
  if (bundled.length) bom = withComponents(bom, npmSbom(false), bundled);
  const nodeVersion = readFileSync(join(root, "scripts/bundled-node-version.txt"), "utf8").trim();
  bom = { ...bom, components: [...bom.components, nodeRuntimeComponent(nodeVersion)] };
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `kai_${version}_sbom-npm.cdx.json`);
  writeFileSync(file, JSON.stringify(bom, null, 2) + "\n");
  console.log(
    `${file}: ${bom.components.length} components` +
      (bundled.length ? ` (bundled devDependencies included: ${bundled.join(", ")})` : "")
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
