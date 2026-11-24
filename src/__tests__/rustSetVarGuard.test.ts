import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * REL-10: changing the process environment while other threads read it is undefined behaviour
 * (`set_var` is `unsafe` in Rust 2024; WebKitGTK and `Command` spawns read it). The one
 * production call is the login-shell PATH, applied first thing in `run()` before any other thread
 * starts. Anything new must pass the value to the child (`Command::env`) instead.
 */
const SRC = path.resolve(__dirname, "../../src-tauri/src");

/** The part of a Rust file before its `#[cfg(test)] mod ...` block (tests may set variables). */
function productionPart(source: string): string {
  const m = /#\[cfg\(test\)\]\s*mod\s+\w+/.exec(source);
  return m ? source.slice(0, m.index) : source;
}

function rustFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return rustFiles(full);
    return e.name.endsWith(".rs") ? [full] : [];
  });
}

describe("REL-10: no process environment changes after startup", () => {
  it("calls set_var / remove_var in production code only in the startup PATH step", () => {
    const calls: string[] = [];
    for (const file of rustFiles(SRC)) {
      const code = productionPart(fs.readFileSync(file, "utf8"));
      code.split("\n").forEach((line, i) => {
        if (/\b(set_var|remove_var)\s*\(/.test(line) && !line.trim().startsWith("//")) {
          calls.push(`${path.relative(SRC, file).replace(/\\/g, "/")}:${i + 1}`);
        }
      });
    }
    // login_path.rs: the startup PATH (Unix, before any thread). kai_cli.rs: Windows only, where
    // the environment API is thread-safe; on Unix that path records the folder for each child.
    expect(calls.map((c) => c.split(":")[0]).sort()).toEqual(["kai_cli.rs", "login_path.rs"]);
  });

  it("keeps the kai_cli.rs PATH update Windows-only", () => {
    const code = productionPart(fs.readFileSync(path.join(SRC, "kai_cli.rs"), "utf8"));
    const fnStart = code.indexOf("fn set_windows_process_path");
    expect(fnStart).toBeGreaterThan(-1);
    const before = code.slice(0, fnStart).trimEnd();
    expect(before.endsWith('#[cfg(target_os = "windows")]')).toBe(true);
    expect(code.slice(fnStart).indexOf("set_var(")).toBeGreaterThan(-1);
  });

  it("applies that PATH before anything else in run()", () => {
    const lib = fs.readFileSync(path.join(SRC, "lib.rs"), "utf8");
    const body = lib.slice(lib.indexOf("pub fn run()"));
    const firstStatement = body
      .split("\n")
      .slice(1)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("//") && !l.startsWith("#["));
    expect(firstStatement).toBe("login_path::apply_login_shell_path();");
  });
});
