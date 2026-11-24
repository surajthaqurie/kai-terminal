import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { describe, expect, it } from "vitest";

/** CI-03: the release SBOM must list what ships, including code the CLI build bundles. */
type Component = { "bom-ref": string; name: string; version?: string; type?: string };
type Bom = {
  components: Component[];
  dependencies?: Array<{ ref: string; dependsOn?: string[] }>;
};
const load = async () =>
  (await import(
    pathToFileURL(path.resolve(__dirname, "../../scripts/generate-sbom.mjs")).href
  )) as {
    bundledDevPackages(config: string, dev: Record<string, string>): string[];
    withComponents(base: Bom, full: Bom, names: string[]): Bom;
    nodeRuntimeComponent(version: string): Component & { purl: string };
  };

const c = (name: string, version = "1.0.0"): Component => ({
  "bom-ref": `${name}@${version}`,
  name,
  version,
});

describe("generate-sbom", () => {
  it("finds the devDependencies the CLI build bundles (noExternal), and only those", async () => {
    const { bundledDevPackages } = await load();
    const config = `ssr: { noExternal: ["gpt-tokenizer", "some-runtime-dep"] },`;
    expect(bundledDevPackages(config, { "gpt-tokenizer": "^4", vitest: "^3" })).toEqual([
      "gpt-tokenizer",
    ]);
    expect(bundledDevPackages("no such option", { vitest: "^3" })).toEqual([]);
  });

  it("the real CLI config bundles gpt-tokenizer, which is a devDependency", async () => {
    const { bundledDevPackages } = await load();
    const root = path.resolve(__dirname, "../..");
    const config = fs.readFileSync(path.join(root, "vite.cli.config.ts"), "utf8");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(bundledDevPackages(config, pkg.devDependencies)).toContain("gpt-tokenizer");
  });

  it("adds a bundled package and everything it depends on, without duplicates", async () => {
    const { withComponents } = await load();
    const base: Bom = { components: [c("react"), c("shared")], dependencies: [] };
    const full: Bom = {
      components: [c("react"), c("shared"), c("tok"), c("tok-dep"), c("vitest")],
      dependencies: [
        { ref: "tok@1.0.0", dependsOn: ["tok-dep@1.0.0", "shared@1.0.0"] },
        { ref: "vitest@1.0.0", dependsOn: [] },
      ],
    };
    const out = withComponents(base, full, ["tok"]);
    expect(out.components.map((x) => x.name)).toEqual(["react", "shared", "tok", "tok-dep"]);
    expect(out.dependencies?.map((d) => d.ref)).toEqual(["tok@1.0.0"]);
    expect(base.components).toHaveLength(2); // inputs untouched
  });

  it("fails loudly when a bundled package is not in the lockfile", async () => {
    const { withComponents } = await load();
    expect(() => withComponents({ components: [] }, { components: [] }, ["gone"])).toThrow("gone");
  });

  it("describes the bundled Node.js runtime", async () => {
    const { nodeRuntimeComponent } = await load();
    const node = nodeRuntimeComponent("24.22.3");
    expect(node).toMatchObject({ type: "application", name: "node", version: "24.22.3" });
    expect(node.purl).toContain("nodejs@24.22.3");
  });

  it("the release builds both SBOMs and keeps them apart from the installers", () => {
    const release = fs.readFileSync(
      path.resolve(__dirname, "../../.github/workflows/release.yml"),
      "utf8"
    );
    expect(release).toContain("node scripts/generate-sbom.mjs release-sbom");
    // The gate runs on Linux: without --target all the Rust SBOM would omit Windows/macOS crates.
    expect(release).toMatch(/cargo cyclonedx [^\n]*--target all/);
    // Installers are downloaded by the kai-* pattern, so the SBOM artifact never reaches the
    // installer checks or the release notes' installer list; it is attached on its own.
    expect(release).toMatch(/pattern:\s*kai-\*/);
    expect(release).toContain("release-sbom/*.cdx.json");
  });
});
