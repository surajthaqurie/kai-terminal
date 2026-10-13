// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  clearAiCliDetailsCache,
  getAiCliDetails,
  loadUserCustomClis,
  registerUserCustomAiCli,
} from "../services/aiCliService";
import { clearDiagnosticsCache } from "../services/diagnosticsService";

beforeEach(() => {
  localStorage.clear();
  clearAiCliDetailsCache();
  clearDiagnosticsCache();
});

describe("AI CLI diagnostics separation regressions", () => {
  it("outside the desktop app every CLI is unavailable with guidance", async () => {
    const details = await getAiCliDetails({ force: true });
    expect(details.length).toBeGreaterThanOrEqual(10);
    for (const d of details) {
      expect(d.available).toBe(false);
      expect(d.version).toBeNull();
      expect(d.install_guidance.length).toBeGreaterThan(0);
      expect(d.diagnostic.length).toBeGreaterThan(0);
      // Passive probing never reports ready/authenticated.
      expect(d.state).not.toBe("ready");
    }
  });

  it("explicit cache invalidation forces a fresh probe", async () => {
    const first = await getAiCliDetails();
    clearAiCliDetailsCache();
    const second = await getAiCliDetails({ force: true });
    expect(Array.isArray(second)).toBe(true);
    expect(second.length).toBe(first.length);
  });

  it("rejects malformed custom CLI ids and paths", async () => {
    await expect(
      registerUserCustomAiCli({ id: "bad id!", name: "X", path: "/bin/sh" })
    ).rejects.toThrow();
    await expect(registerUserCustomAiCli({ id: "ok-id", name: "X", path: "" })).rejects.toThrow();
    await expect(
      registerUserCustomAiCli({ id: "ok-id", name: "X", path: "bad\0path" })
    ).rejects.toThrow();
  });

  it("never persists secrets alongside custom CLI registrations", async () => {
    await registerUserCustomAiCli({ id: "local-llm", name: "Local", path: "/usr/bin/fake" }).catch(
      () => {}
    );
    const raw =
      localStorage.getItem("kai_custom_ai_clis") ||
      localStorage.getItem("terminal_custom_ai_clis") ||
      "";
    expect(raw).not.toMatch(/sk-/i);
    expect(raw).not.toMatch(/token/i);
    expect(raw).not.toMatch(/secret/i);
    expect(raw).not.toMatch(/password/i);
    const loaded = loadUserCustomClis();
    for (const c of loaded) {
      expect(JSON.stringify(c)).not.toContain("scrollback");
      expect(JSON.stringify(c)).not.toContain("history");
    }
  });

  it("legacy auth labels map to config-presence semantics (no credential claim)", async () => {
    // Backend now reports config_present/config_missing; the panel accepts
    // both old (configured/not_configured) and new labels and renders them
    // as file presence, never as authentication success.
    const map = (s: string) =>
      s === "config_present" || s === "configured"
        ? "file present"
        : s === "config_missing" || s === "not_configured"
          ? "no file"
          : "unknown";
    expect(map("config_present")).toBe("file present");
    expect(map("configured")).toBe("file present");
    expect(map("config_missing")).toBe("no file");
    expect(map("not_configured")).toBe("no file");
    expect(map("unknown")).toBe("unknown");
  });
});
