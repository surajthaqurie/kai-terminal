import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  quoteCmdShimArg,
  resolveSpawnTarget,
  runExternalAgentCommand,
} from "../core/codeModeWorkflow";

/** Arguments that exercise every parser the text passes through. */
const NASTY_ARGS = [
  "plain",
  "two words",
  'say "hi"',
  "a & b",
  "a && b || c",
  "pipe | out > file < in",
  "caret ^ here ^^",
  "100%",
  "%PATH% and %USERPROFILE%",
  "!delayed! (paren) [bracket]",
  "semi;colon,comma=equals",
  "star * and ? mark",
  "back`tick",
  "trailing backslash\\",
  "trailing backslashes\\\\",
  'quote after backslash \\"x\\\\"',
  "C:\\Users\\Some User\\dir\\",
  "",
  "émoji ✓ 日本語",
];

/** `^x` -> `x`, as cmd.exe does when it reads a line (one level per parse). */
const stripCarets = (text: string): string => text.replace(/\^(.)/g, "$1");

/** Split a command line the way the MS C runtime does (what node and most agents use). */
function crtSplit(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\") {
      let n = 0;
      while (line[i] === "\\") {
        n++;
        i++;
      }
      if (line[i] === '"') {
        cur += "\\".repeat(Math.floor(n / 2));
        if (n % 2 === 1) {
          cur += '"';
        } else {
          inQuote = !inQuote;
        }
      } else {
        cur += "\\".repeat(n);
        i--;
      }
      started = true;
    } else if (ch === '"') {
      inQuote = !inQuote;
      started = true;
    } else if (!inQuote && (ch === " " || ch === "\t")) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

describe("quoteCmdShimArg (pure)", () => {
  it("survives cmd.exe's two caret-stripping passes and the C runtime's argv split", () => {
    for (const arg of NASTY_ARGS) {
      const quoted = quoteCmdShimArg(arg);
      // cmd /c parses the line, then the shim's `%*` line is parsed again.
      const afterCmd = stripCarets(stripCarets(quoted));
      expect(crtSplit(afterCmd), JSON.stringify(arg)).toEqual([arg]);
    }
  });

  it("leaves no cmd metacharacter bare for either cmd pass", () => {
    const meta = /[()%!^"`<>&|;, *?[\]]/;
    for (const arg of NASTY_ARGS) {
      const quoted = quoteCmdShimArg(arg);
      // After the first pass every metacharacter must still be caret-escaped
      // (the second pass consumes that caret); a bare one would be live.
      const afterFirstPass = stripCarets(quoted);
      for (const text of [quoted, afterFirstPass]) {
        let i = 0;
        while (i < text.length) {
          if (text[i] === "^") {
            i += 2;
            continue;
          }
          expect(meta.test(text[i]), `${JSON.stringify(arg)} -> ${text}`).toBe(false);
          i++;
        }
      }
    }
  });

  it("quotes spaces, doubles backslashes before quotes and at the end", () => {
    expect(stripCarets(stripCarets(quoteCmdShimArg("a b")))).toBe('"a b"');
    expect(stripCarets(stripCarets(quoteCmdShimArg("dir\\")))).toBe('"dir\\\\"');
    expect(stripCarets(stripCarets(quoteCmdShimArg('x\\"y')))).toBe('"x\\\\\\"y"');
    expect(stripCarets(stripCarets(quoteCmdShimArg("")))).toBe('""');
  });

  it("refuses line breaks and NUL instead of truncating the prompt", () => {
    for (const bad of ["a\nb", "a\r\nb", "a\0b"]) {
      expect(() => quoteCmdShimArg(bad)).toThrow(/line break/);
    }
  });
});

describe("resolveSpawnTarget for batch files (pure)", () => {
  it("quotes the command path and every argument into one verbatim /c line", () => {
    const target = resolveSpawnTarget(
      "C:\\Users\\Some User\\npm\\claude.cmd",
      ["fix the bug", "a&b"],
      "win32"
    );
    expect(target.windowsVerbatimArguments).toBe(true);
    expect(target.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(target.args).toHaveLength(4);
    expect(target.args[3]).toBe(
      `""C:\\Users\\Some User\\npm\\claude.cmd" ${quoteCmdShimArg("fix the bug")} ${quoteCmdShimArg("a&b")}"`
    );
    // The `&` can never reach cmd.exe unescaped.
    expect(target.args[3]).not.toMatch(/(^|[^^])&/);
  });

  it("rejects a launcher path that could close the quoting", () => {
    expect(() => resolveSpawnTarget('C:\\x" & calc & "y.cmd', [], "win32")).toThrow(/Refusing/);
  });

  it("leaves real executables and POSIX untouched", () => {
    expect(resolveSpawnTarget("C:\\Program Files\\x\\claude.exe", ["a b"], "win32")).toEqual({
      command: "C:\\Program Files\\x\\claude.exe",
      args: ["a b"],
    });
    expect(resolveSpawnTarget("/usr/bin/claude", ["a & b"], "linux")).toEqual({
      command: "/usr/bin/claude",
      args: ["a & b"],
    });
  });
});

describe.runIf(process.platform === "win32")("a .cmd launcher run for real (Windows)", () => {
  let dir: string;

  beforeEach(() => {
    // A space in the folder name is the profile-path case that used to fail.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai cmd shim "));
    // The shape of an npm shim: run the agent with all arguments forwarded.
    fs.writeFileSync(
      path.join(dir, "agent.js"),
      "require('fs').writeFileSync(process.env.KAI_ARGV_OUT, JSON.stringify(process.argv.slice(2)));\n"
    );
    fs.writeFileSync(
      path.join(dir, "agent.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0agent.js" %*\r\n`
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function run(args: string[]): Promise<string[]> {
    const out = path.join(dir, "argv.json");
    const target = resolveSpawnTarget(path.join(dir, "agent.cmd"), args);
    const result = await runExternalAgentCommand(target.command, target.args, {
      cwd: dir,
      env: { ...process.env, KAI_ARGV_OUT: out },
      windowsVerbatimArguments: target.windowsVerbatimArguments,
    });
    expect(result.exitCode).toBe(0);
    return JSON.parse(fs.readFileSync(out, "utf8")) as string[];
  }

  it("delivers every argument intact, spaces and metacharacters included", async () => {
    expect(await run(NASTY_ARGS)).toEqual(NASTY_ARGS);
  });

  it("never lets an argument start a second command", async () => {
    const canary = path.join(dir, "canary.txt");
    const hostile = [
      `x & echo pwned > "${canary}"`,
      `x | echo pwned > "${canary}"`,
      `"& echo pwned > "${canary}" & "`,
    ];
    expect(await run(hostile)).toEqual(hostile);
    expect(fs.existsSync(canary)).toBe(false);
  });

  it("reports a launcher failure as the exit code", async () => {
    fs.writeFileSync(path.join(dir, "fail.cmd"), "@echo off\r\nexit /b 7\r\n");
    const target = resolveSpawnTarget(path.join(dir, "fail.cmd"), ["a b"]);
    const result = await runExternalAgentCommand(target.command, target.args, {
      cwd: dir,
      windowsVerbatimArguments: target.windowsVerbatimArguments,
    });
    expect(result.exitCode).toBe(7);
  });
});
