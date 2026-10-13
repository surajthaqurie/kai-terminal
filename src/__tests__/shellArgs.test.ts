import { describe, it, expect } from "vitest";
import { isPowerShellPath, withSkipProfileArgs } from "../services/shellArgs";
import type { ShellProfile } from "../types/terminal";

const pwsh: ShellProfile = {
  id: "pwsh",
  name: "PowerShell Core",
  path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  args: ["-NoLogo"],
  is_default: true,
  is_wsl: false,
};

describe("shell fast-launch args", () => {
  it("detects powershell/pwsh binaries on any path style", () => {
    expect(isPowerShellPath("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe(
      true
    );
    expect(isPowerShellPath("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(true);
    expect(isPowerShellPath("/usr/bin/pwsh")).toBe(true);
    expect(isPowerShellPath("pwsh")).toBe(true);
    expect(isPowerShellPath("POWERSHELL.EXE")).toBe(true);
    expect(isPowerShellPath("C:\\Windows\\System32\\cmd.exe")).toBe(false);
    expect(isPowerShellPath("/bin/bash")).toBe(false);
    expect(isPowerShellPath(undefined)).toBe(false);
    expect(isPowerShellPath("")).toBe(false);
  });

  it("adds -NoProfile (keeping -NoLogo) for PowerShell when enabled", () => {
    const out = withSkipProfileArgs(pwsh, true);
    expect(out?.args).toEqual(["-NoLogo", "-NoProfile"]);
    // Input object is not mutated.
    expect(pwsh.args).toEqual(["-NoLogo"]);
  });

  it("dedupes existing flags case-insensitively", () => {
    const shell: ShellProfile = { ...pwsh, args: ["-nologo", "-NoProfile"] };
    const out = withSkipProfileArgs(shell, true);
    expect(out?.args).toEqual(["-nologo", "-NoProfile"]);
  });

  it("returns the same object when disabled or for non-PowerShell shells", () => {
    expect(withSkipProfileArgs(pwsh, false)).toBe(pwsh);
    const cmd: ShellProfile = {
      id: "cmd",
      name: "Command Prompt",
      path: "C:\\Windows\\System32\\cmd.exe",
      is_default: false,
      is_wsl: false,
    };
    expect(withSkipProfileArgs(cmd, true)).toBe(cmd);
    expect(withSkipProfileArgs(undefined, true)).toBeUndefined();
  });
});
