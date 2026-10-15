import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { lineLikelyChangesCodeMode } from "../services/cwdCommand";
import {
  isCodeModeActiveForDir,
  resolveModeDisplay,
  codeProjectName,
} from "../services/projectService";

describe("resolveModeDisplay (footer pill: global + per-pane truth)", () => {
  it("is terminal without a persisted project — always clears, even mid-resolve", () => {
    expect(resolveModeDisplay(null, "/repo/demo")).toBe("terminal");
    expect(resolveModeDisplay(null, "")).toBe("terminal");
    // `kai stop code` must reflect at once, not keep a stale pill.
    expect(resolveModeDisplay(null, "/repo/demo", "code")).toBe("terminal");
    expect(resolveModeDisplay(null, "", "code")).toBe("terminal");
  });

  it("is code inside the project (exact dir and children)", () => {
    expect(resolveModeDisplay("/repo/demo", "/repo/demo")).toBe("code");
    expect(resolveModeDisplay("/repo/demo", "/repo/demo/sub")).toBe("code");
    expect(resolveModeDisplay("C:\\Repo\\Demo", "c:/repo/demo/src")).toBe("code");
  });

  it("is terminal when the pane sits outside the project (no other project name shown)", () => {
    expect(resolveModeDisplay("/repo/demo", "/repo/other")).toBe("terminal");
    expect(resolveModeDisplay("/repo/demo", "/repo/demo-x")).toBe("terminal");
    // Same pane flips back to Code Mode once it is inside the project again.
    expect(resolveModeDisplay("/repo/demo", "/repo/demo/src", "terminal")).toBe("code");
  });

  it("keeps the previous pill while the cwd is still resolving", () => {
    expect(resolveModeDisplay("/repo/demo", "", "code")).toBe("code");
    expect(resolveModeDisplay("/repo/demo", "", "terminal")).toBe("terminal");
    expect(resolveModeDisplay("/repo/demo", "")).toBe("terminal");
  });
});

describe("codeProjectName", () => {
  it("shows the last path segment on every OS shape", () => {
    expect(codeProjectName("/repo/demo")).toBe("demo");
    expect(codeProjectName("C:\\work\\app")).toBe("app");
    expect(codeProjectName("C:/work/app/")).toBe("app");
    expect(codeProjectName(null)).toBe("");
  });
});

describe("lineLikelyChangesCodeMode", () => {
  it("returns false for empty input and non-kai commands", () => {
    expect(lineLikelyChangesCodeMode("")).toBe(false);
    expect(lineLikelyChangesCodeMode("ls -la")).toBe(false);
    expect(lineLikelyChangesCodeMode("git status")).toBe(false);
    expect(lineLikelyChangesCodeMode("cd /tmp")).toBe(false);
    expect(lineLikelyChangesCodeMode("my-kai-tool")).toBe(false);
    expect(lineLikelyChangesCodeMode("kaiman")).toBe(false);
  });

  it("returns false for read-only kai subcommands", () => {
    expect(lineLikelyChangesCodeMode("kai")).toBe(false);
    expect(lineLikelyChangesCodeMode("kai --version")).toBe(false);
    expect(lineLikelyChangesCodeMode("kai health")).toBe(false);
    expect(lineLikelyChangesCodeMode('kai query "explain this"')).toBe(false);
    expect(lineLikelyChangesCodeMode("kai config list")).toBe(false);
    expect(lineLikelyChangesCodeMode("kai list")).toBe(false);
    expect(lineLikelyChangesCodeMode("kai list -a")).toBe(false);
  });

  it("detects state-changing kai subcommands", () => {
    expect(lineLikelyChangesCodeMode("kai code .")).toBe(true);
    expect(lineLikelyChangesCodeMode("kai code /repo/demo")).toBe(true);
    expect(lineLikelyChangesCodeMode("kai stop")).toBe(true);
    expect(lineLikelyChangesCodeMode("kai stop code")).toBe(true);
    expect(lineLikelyChangesCodeMode("kai clear")).toBe(true);
    expect(lineLikelyChangesCodeMode("KAI CODE .")).toBe(true);
    expect(lineLikelyChangesCodeMode("  kai   code   .  ")).toBe(true);
  });

  it("detects direct-path invocation (kai <path> also enters Code Mode)", () => {
    expect(lineLikelyChangesCodeMode("kai .")).toBe(true);
    expect(lineLikelyChangesCodeMode("kai ~/proj")).toBe(true);
    expect(lineLikelyChangesCodeMode("kai ./sub")).toBe(true);
    expect(lineLikelyChangesCodeMode("kai ../up")).toBe(true);
    expect(lineLikelyChangesCodeMode("kai /tmp/x")).toBe(true);
    expect(lineLikelyChangesCodeMode("kai C:\\work\\app")).toBe(true);
  });

  it("detects kai state changes inside compound lines and wrappers", () => {
    expect(lineLikelyChangesCodeMode("cd /repo && kai code .")).toBe(true);
    expect(lineLikelyChangesCodeMode("ls; kai stop code")).toBe(true);
    expect(lineLikelyChangesCodeMode("sudo kai code .")).toBe(true);
    expect(lineLikelyChangesCodeMode("npx kai stop code")).toBe(true);
  });
});

describe("isCodeModeActiveForDir", () => {
  it("returns false without inputs", () => {
    expect(isCodeModeActiveForDir("", "/repo")).toBe(false);
    expect(isCodeModeActiveForDir("/repo", null)).toBe(false);
    expect(isCodeModeActiveForDir("", null)).toBe(false);
  });

  it("matches the project dir and subdirectories only", () => {
    expect(isCodeModeActiveForDir("/repo/demo", "/repo/demo")).toBe(true);
    expect(isCodeModeActiveForDir("/repo/demo/sub", "/repo/demo")).toBe(true);
    expect(isCodeModeActiveForDir("/repo/other", "/repo/demo")).toBe(false);
    // Bare prefix is NOT enough.
    expect(isCodeModeActiveForDir("/repo/demo-x", "/repo/demo")).toBe(false);
  });

  it("normalizes separators, trailing slashes and Windows case", () => {
    expect(isCodeModeActiveForDir("C:\\Repo\\Demo\\", "c:/repo/demo")).toBe(true);
    expect(isCodeModeActiveForDir("c:/REPO/DEMO/sub", "C:\\repo\\demo")).toBe(true);
    expect(isCodeModeActiveForDir("//?/C:/repo/demo", "C:\\repo\\demo")).toBe(true);
    // POSIX stays case-sensitive.
    expect(isCodeModeActiveForDir("/Repo/Demo", "/repo/demo")).toBe(false);
  });

  it("tolerates the macOS /private alias (realpath vs logical $PWD)", () => {
    expect(isCodeModeActiveForDir("/tmp/work", "/private/tmp/work")).toBe(true);
    expect(isCodeModeActiveForDir("/private/tmp/work/sub", "/tmp/work")).toBe(true);
    expect(isCodeModeActiveForDir("/tmp/other", "/private/tmp/work")).toBe(false);
  });
});

describe("kai code end-to-end state file", () => {
  let savedKaiHome: string | undefined;
  let tmpBase: string;

  beforeEach(() => {
    savedKaiHome = process.env.KAI_HOME;
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "kai-codemode-"));
    process.env.KAI_HOME = path.join(tmpBase, "kai_home");
  });

  afterEach(() => {
    if (savedKaiHome === undefined) delete process.env.KAI_HOME;
    else process.env.KAI_HOME = savedKaiHome;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it("kai graph init <dir> persists mode=code state the badge can read", async () => {
    const { runCli } = await import("../cli/index");
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-codemode-proj-"));
    fs.writeFileSync(path.join(projDir, "a.txt"), "hello\n");
    try {
      const exit = await runCli(["node", "kai", "graph", "init", projDir]);
      expect(exit).toBe(0);
      const raw = fs.readFileSync(
        path.join(process.env.KAI_HOME as string, "active_project.json"),
        "utf-8"
      );
      const state = JSON.parse(raw);
      expect(state.mode).toBe("code");
      expect(state.path).toBe(fs.realpathSync(projDir));
      // Badge predicate agrees for the project dir and children.
      expect(isCodeModeActiveForDir(state.path, state.path)).toBe(true);
      expect(isCodeModeActiveForDir(path.join(state.path, "sub"), state.path)).toBe(true);
    } finally {
      fs.rmSync(projDir, { recursive: true, force: true });
    }
  });

  it("kai stop code clears Code Mode state", async () => {
    const { runCli } = await import("../cli/index");
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-codemode-proj-"));
    fs.writeFileSync(path.join(projDir, "a.txt"), "hello\n");
    try {
      expect(await runCli(["node", "kai", "graph", "init", projDir])).toBe(0);
      expect(await runCli(["node", "kai", "stop", "code"])).toBe(0);
      expect(fs.existsSync(path.join(process.env.KAI_HOME as string, "active_project.json"))).toBe(
        false
      );
    } finally {
      fs.rmSync(projDir, { recursive: true, force: true });
    }
  });

  it("plain kai stop (no arg) also clears Code Mode state", async () => {
    const { runCli } = await import("../cli/index");
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-codemode-proj-"));
    fs.writeFileSync(path.join(projDir, "a.txt"), "hello\n");
    try {
      expect(await runCli(["node", "kai", "graph", "init", projDir])).toBe(0);
      expect(await runCli(["node", "kai", "stop"])).toBe(0);
      expect(fs.existsSync(path.join(process.env.KAI_HOME as string, "active_project.json"))).toBe(
        false
      );
    } finally {
      fs.rmSync(projDir, { recursive: true, force: true });
    }
  });
});
