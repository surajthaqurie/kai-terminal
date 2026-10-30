import { describe, expect, it } from "vitest";
import { resolvePaneShell, sameShellPath } from "../services/paneShell";
import type { ShellProfile } from "../types/terminal";

const pwsh: ShellProfile = {
  id: "pwsh",
  name: "PowerShell 7",
  path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  is_default: true,
};
const bash: ShellProfile = {
  id: "gitbash",
  name: "Git Bash",
  path: "C:\\Program Files\\Git\\bin\\bash.exe",
  is_default: false,
};
const shells = [pwsh, bash];

describe("sameShellPath", () => {
  it("ignores slash style and letter case", () => {
    expect(sameShellPath("C:\\Git\\bin\\bash.exe", "c:/git/bin/BASH.exe")).toBe(true);
    expect(sameShellPath("/bin/bash", "/bin/zsh")).toBe(false);
  });

  it("never matches a missing path", () => {
    expect(sameShellPath(undefined, "/bin/bash")).toBe(false);
    expect(sameShellPath("/bin/bash", "")).toBe(false);
    expect(sameShellPath(undefined, undefined)).toBe(false);
  });
});

describe("resolvePaneShell", () => {
  it("uses the app-wide shell for a pane that has none of its own", () => {
    expect(resolvePaneShell(undefined, shells, pwsh, false)).toBe(pwsh);
  });

  it("returns the app-wide shell itself when the pane runs its binary (custom path and flags kept)", () => {
    const custom = { ...pwsh, name: "PowerShell 7 (custom)", args: ["-NoLogo"] };
    expect(resolvePaneShell(pwsh.path.toLowerCase(), shells, custom, false)).toBe(custom);
  });

  it("maps another detected binary back to its profile", () => {
    expect(resolvePaneShell(bash.path, shells, pwsh, false)).toBe(bash);
  });

  it("applies the fast-launch flags to a PowerShell profile that is not the app-wide shell", () => {
    const winPs: ShellProfile = {
      id: "powershell",
      name: "Windows PowerShell",
      path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      is_default: false,
    };
    const resolved = resolvePaneShell(winPs.path, [pwsh, winPs], bash, true)!;
    expect(resolved.args).toEqual(["-NoLogo", "-NoProfile"]);
    expect(resolvePaneShell(bash.path, shells, pwsh, true)!.args).toBeUndefined();
  });

  it("falls back to the app-wide shell for a binary that is no longer installed", () => {
    expect(resolvePaneShell("C:\\gone\\fish.exe", shells, pwsh, false)).toBe(pwsh);
  });

  it("is undefined while nothing is known yet", () => {
    expect(resolvePaneShell(undefined, [], undefined, false)).toBeUndefined();
    expect(resolvePaneShell("/bin/zsh", [], undefined, false)).toBeUndefined();
  });
});
