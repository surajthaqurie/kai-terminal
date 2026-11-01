// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiCliDetails } from "../services/aiCliService";

/** What the desktop backend answers; each test sets what is "installed". */
let installed: Record<string, string> = {};
const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === "get_ai_cli_details") {
    return ["claude", "codex"].map<AiCliDetails>((id) => ({
      id,
      name: id,
      available: false,
      path: null,
      version: null,
      install_guidance: "",
      diagnostic: "not found",
    }));
  }
  if (cmd === "check_ai_cli_path") {
    const id = String(args?.id);
    const path = String(args?.customPath);
    const ok = installed[path] !== undefined;
    return {
      id,
      name: id.replace(/^custom:/, ""),
      available: ok,
      path: ok ? path : null,
      version: ok ? installed[path] : null,
      install_guidance: "",
      diagnostic: ok ? "" : `Binary '${path}' is missing or not executable.`,
    } satisfies AiCliDetails;
  }
  throw new Error(`unmocked ${cmd}`);
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: Parameters<typeof invoke>) => invoke(...a),
}));
vi.mock("../services/ptyService", () => ({ isTauriAvailable: () => true }));

import {
  clearAiCliDetailsCache,
  getAiCliDetails,
  loadUserCustomClis,
  registerUserCustomAiCli,
  removeUserCustomAiCli,
  saveAiCliPathOverride,
} from "../services/aiCliService";

beforeEach(() => {
  localStorage.clear();
  clearAiCliDetailsCache();
  installed = {};
  invoke.mockClear();
});

describe("registering a custom CLI", () => {
  it("saves nothing when the path does not work, and says why", async () => {
    await expect(
      registerUserCustomAiCli({ id: "mytool", name: "My Tool", path: "C:\\typo\\tool.exe" })
    ).rejects.toThrow(/missing or not executable/);
    expect(loadUserCustomClis()).toEqual([]);
  });

  it("saves a binary that validates", async () => {
    installed["C:\\bin\\tool.exe"] = "1.2.3";
    const details = await registerUserCustomAiCli({
      id: "mytool",
      name: "My Tool",
      path: "C:\\bin\\tool.exe",
    });
    expect(details.available).toBe(true);
    expect(loadUserCustomClis().map((c) => c.id)).toEqual(["mytool"]);
  });

  it("an entry can be removed, and is gone from the details afterwards", async () => {
    installed["C:\\bin\\tool.exe"] = "1.2.3";
    await registerUserCustomAiCli({ id: "mytool", name: "My Tool", path: "C:\\bin\\tool.exe" });
    expect((await getAiCliDetails({ force: true })).some((d) => d.id === "custom:mytool")).toBe(
      true
    );

    expect(removeUserCustomAiCli("mytool")).toBe(true);
    expect(loadUserCustomClis()).toEqual([]);
    expect((await getAiCliDetails({ force: true })).some((d) => d.id === "custom:mytool")).toBe(
      false
    );
  });

  it("removing something that is not registered reports false", () => {
    expect(removeUserCustomAiCli("nope")).toBe(false);
  });
});

describe("a path validated for a built-in provider", () => {
  it("survives a re-detect instead of reverting to Not found", async () => {
    installed["D:\\tools\\claude.exe"] = "2.0.0";
    expect((await getAiCliDetails({ force: true })).find((d) => d.id === "claude")?.available).toBe(
      false
    );

    expect(saveAiCliPathOverride("claude", "D:\\tools\\claude.exe")).toBe(true);

    const after = await getAiCliDetails({ force: true });
    const claude = after.find((d) => d.id === "claude")!;
    expect(claude.available).toBe(true);
    expect(claude.path).toBe("D:\\tools\\claude.exe");
    // Providers without an override are untouched.
    expect(after.find((d) => d.id === "codex")?.available).toBe(false);
  });

  it("keeps showing Not found if the remembered binary was later deleted", async () => {
    installed["D:\\tools\\claude.exe"] = "2.0.0";
    saveAiCliPathOverride("claude", "D:\\tools\\claude.exe");
    delete installed["D:\\tools\\claude.exe"];
    expect((await getAiCliDetails({ force: true })).find((d) => d.id === "claude")?.available).toBe(
      false
    );
  });

  it("refuses to store an empty or NUL-containing path", () => {
    expect(saveAiCliPathOverride("claude", "   ")).toBe(false);
    expect(saveAiCliPathOverride("claude", "bad\0path")).toBe(false);
  });
});
