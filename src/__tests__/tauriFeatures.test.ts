import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * tauri-build refuses to build when the `tauri` crate's features disagree with tauri.conf.json,
 * and it checks only the `[dependencies]` entry (a `[target.*]` entry is ignored while that one
 * exists, and every `[target.*]` entry is checked on every platform when it does not). A setting
 * placed only in a platform file (tauri.macos.conf.json) therefore broke `cargo build` and
 * `cargo clippy` on that platform, while `tauri build` patched the features up and hid it. The
 * first CI run with the GUI-feature clippy step failed on macOS for exactly this reason.
 */
const dir = path.resolve(__dirname, "../../src-tauri");
const cargo = fs.readFileSync(path.join(dir, "Cargo.toml"), "utf8");
const readJson = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));

/** `[section]` name for every `tauri = ...` dependency line. */
function tauriEntries(): Array<{ section: string; line: string }> {
  let section = "";
  const out: Array<{ section: string; line: string }> = [];
  for (const raw of cargo.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) section = header[1];
    // Only dependency tables; `[features]` has its own `tauri = [...]` feature list.
    else if (/^tauri\s*=/.test(line) && /(^|\.)dependencies$/.test(section))
      out.push({ section, line });
  }
  return out;
}

describe("tauri crate features agree with tauri.conf.json on every platform", () => {
  it("there is exactly one tauri dependency, in [dependencies]", () => {
    expect(tauriEntries().map((e) => e.section)).toEqual(["dependencies"]);
  });

  it("macOSPrivateApi is set in the base config (not only a platform file) and the feature is on", () => {
    const base = readJson("tauri.conf.json");
    const features = /features\s*=\s*\[([^\]]*)\]/.exec(tauriEntries()[0].line)?.[1] ?? "";
    expect(base.app.macOSPrivateApi === true).toBe(features.includes('"macos-private-api"'));
  });

  it("no platform file sets a value that tauri-build would compare against the features", () => {
    const platformFiles = fs
      .readdirSync(dir)
      .filter((f) => /^tauri\.(macos|linux|windows)\.conf\.json$/.test(f));
    expect(platformFiles.length).toBeGreaterThan(0);
    for (const file of platformFiles) {
      const app = readJson(file).app ?? {};
      expect(app, file).not.toHaveProperty("macOSPrivateApi");
      expect(app, file).not.toHaveProperty("trayIcon");
    }
  });
});
