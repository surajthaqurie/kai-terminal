import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * CI-03: a floating `@v4` tag can be moved by whoever controls that repository, and the release
 * job holds `contents: write`. Every action is pinned to a commit; dependabot proposes updates.
 */
const dir = path.resolve(__dirname, "../../.github/workflows");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".yml"));

describe("workflow actions are pinned to commits", () => {
  it("there are workflows to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file}: every third-party action names a full commit SHA`, () => {
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      const uses = [...text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1]);
      for (const ref of uses) {
        if (ref.startsWith("./")) continue; // an action in this repository
        expect(ref, `${file}: ${ref}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      }
    });

    it(`${file}: the Rust toolchain is named explicitly (a SHA does not choose one)`, () => {
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      const blocks = text.split(/uses:\s*dtolnay\/rust-toolchain@/).slice(1);
      for (const block of blocks) {
        const head = block.split(/\n\s*-\s+name:/)[0];
        expect(head).toMatch(/toolchain:\s*\S+/);
      }
    });
  }
});

/**
 * CI-03 / CI-09: CI, release and the Docker test image build with one exact Rust version, kept in
 * scripts/rust-toolchain-version.txt. (Not a rust-toolchain.toml: that would also force the version
 * on local builds, and on Windows rustup picks the MSVC host for it, which breaks machines that
 * build with the GNU toolchain.)
 */
describe("CI, release and Docker build with the one pinned Rust version", () => {
  const root = path.resolve(__dirname, "../..");
  const pinned = fs
    .readFileSync(path.join(root, "scripts/rust-toolchain-version.txt"), "utf8")
    .trim();

  it("the pin is an exact version, not a moving channel", () => {
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("there is no rust-toolchain file forcing the version on local builds", () => {
    for (const name of ["rust-toolchain", "rust-toolchain.toml"]) {
      expect(fs.existsSync(path.join(root, name)), name).toBe(false);
      expect(fs.existsSync(path.join(root, "src-tauri", name)), `src-tauri/${name}`).toBe(false);
    }
  });

  for (const file of files) {
    it(`${file}: every Rust install uses the pinned version`, () => {
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      const blocks = text.split(/uses:\s*dtolnay\/rust-toolchain@/).slice(1);
      for (const block of blocks) {
        const head = block.split(/\n\s*-\s+name:/)[0];
        const named = /toolchain:\s*"?([^"\s]+)"?/.exec(head)?.[1];
        expect(named, file).toBe(pinned);
      }
    });
  }

  it("Dockerfile.test installs the pinned version", () => {
    const docker = fs.readFileSync(path.join(root, "Dockerfile.test"), "utf8");
    expect(docker).toContain(`--default-toolchain ${pinned}`);
  });
});
