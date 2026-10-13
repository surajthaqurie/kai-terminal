import { describe, it, expect } from "vitest";
import { lineLikelyChangesCwd } from "../services/cwdCommand";

describe("lineLikelyChangesCwd", () => {
  it("returns false for plain commands and bare Enter", () => {
    expect(lineLikelyChangesCwd("")).toBe(false);
    expect(lineLikelyChangesCwd("   ")).toBe(false);
    expect(lineLikelyChangesCwd("ls -la")).toBe(false);
    expect(lineLikelyChangesCwd("git status")).toBe(false);
    expect(lineLikelyChangesCwd("echo cd")).toBe(false);
    expect(lineLikelyChangesCwd("npm run build")).toBe(false);
    expect(lineLikelyChangesCwd("my-cd-tool")).toBe(false);
    expect(lineLikelyChangesCwd("cdrom")).toBe(false);
    // sudo cannot change our shell's cwd: no probe.
    expect(lineLikelyChangesCwd("sudo cd /root")).toBe(false);
  });

  it("detects posix directory changes", () => {
    expect(lineLikelyChangesCwd("cd /tmp")).toBe(true);
    expect(lineLikelyChangesCwd("  cd")).toBe(true);
    expect(lineLikelyChangesCwd("pushd /x")).toBe(true);
    expect(lineLikelyChangesCwd("popd")).toBe(true);
    expect(lineLikelyChangesCwd("z proj")).toBe(true);
    expect(lineLikelyChangesCwd("j foo")).toBe(true);
    expect(lineLikelyChangesCwd("..")).toBe(true);
    expect(lineLikelyChangesCwd("make && cd out")).toBe(true);
    expect(lineLikelyChangesCwd("npm test; cd ..")).toBe(true);
  });

  it("detects cmd.exe and PowerShell directory changes", () => {
    expect(lineLikelyChangesCwd("cd..")).toBe(true);
    expect(lineLikelyChangesCwd("cd\\")).toBe(true);
    expect(lineLikelyChangesCwd("CD /d C:\\work")).toBe(true);
    expect(lineLikelyChangesCwd("chdir D:\\repo")).toBe(true);
    expect(lineLikelyChangesCwd("sl C:\\x")).toBe(true);
    expect(lineLikelyChangesCwd("Set-Location ~")).toBe(true);
    expect(lineLikelyChangesCwd("c:")).toBe(true);
  });
});
