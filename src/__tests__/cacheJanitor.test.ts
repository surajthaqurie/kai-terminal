// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { CACHE_JANITOR_VERSION_KEY, runCacheJanitor } from "../services/cacheJanitor";

beforeEach(() => {
  localStorage.clear();
});

describe("install/update cache janitor", () => {
  it("removes stale kai_/terminal_ keys but preserves settings, session, and config", () => {
    localStorage.setItem("kai_user_settings", '{"theme":"kali"}');
    localStorage.setItem("terminal_user_settings", '{"theme":"kali"}');
    localStorage.setItem("kai_workspaces_v1", '{"version":2,"workspaces":[]}');
    localStorage.setItem("terminal_workspaces_v1", "[]");
    localStorage.setItem("terminal_tab_layout_v1", "[]");
    localStorage.setItem("kai_recent_projects", "[]");
    localStorage.setItem("terminal_recent_projects", "[]");
    localStorage.setItem("kai_active_project", "/repo");
    localStorage.setItem("kai_active_mode", "code");
    localStorage.setItem("kai_update_last_check", "123");
    localStorage.setItem("kai_update_dismissed_version", "0.1.1");
    localStorage.setItem("kai_cmd_history_v1", "[]");
    localStorage.setItem("kai_custom_ai_clis", "[]");
    localStorage.setItem("terminal_custom_ai_clis", "[]");
    localStorage.setItem("kai_autostart_enabled_mock", "0");
    localStorage.setItem("kai_project_settings_%2Frepo", "{}");
    localStorage.setItem("terminal_project_settings_%2Frepo", "{}");
    // Stale leftovers from older builds + a foreign key.
    localStorage.setItem("kai_stale_experiment_flag", "1");
    localStorage.setItem("terminal_legacy_scratch", "x");
    localStorage.setItem("other_app_key", "keep");

    const report = runCacheJanitor("0.1.2");

    expect(report.ran).toBe(true);
    expect(report.removed.sort()).toEqual(["kai_stale_experiment_flag", "terminal_legacy_scratch"]);
    // Preserved.
    expect(localStorage.getItem("kai_user_settings")).toBe('{"theme":"kali"}');
    expect(localStorage.getItem("terminal_tab_layout_v1")).toBe("[]");
    expect(localStorage.getItem("kai_active_project")).toBe("/repo");
    expect(localStorage.getItem("kai_cmd_history_v1")).toBe("[]");
    expect(localStorage.getItem("kai_project_settings_%2Frepo")).toBe("{}");
    expect(localStorage.getItem("other_app_key")).toBe("keep");
    expect(localStorage.getItem(CACHE_JANITOR_VERSION_KEY)).toBe("0.1.2");
  });

  it("is a no-op when the version marker already matches (no repeated sweeps)", () => {
    localStorage.setItem("kai_stale_experiment_flag", "1");
    const first = runCacheJanitor("0.1.2");
    expect(first.ran).toBe(true);
    expect(first.removed).toEqual(["kai_stale_experiment_flag"]);

    localStorage.setItem("kai_new_stale_key", "1");
    const second = runCacheJanitor("0.1.2");
    expect(second.ran).toBe(false);
    // Same-version leftovers are left alone until the next update.
    expect(localStorage.getItem("kai_new_stale_key")).toBe("1");
  });

  it("sweeps again on update to a new version", () => {
    runCacheJanitor("0.1.2");
    localStorage.setItem("kai_stale_from_012", "1");
    const report = runCacheJanitor("0.1.3");
    expect(report.ran).toBe(true);
    expect(report.removed).toEqual(["kai_stale_from_012"]);
    expect(localStorage.getItem(CACHE_JANITOR_VERSION_KEY)).toBe("0.1.3");
  });

  it("never touches foreign keys even on a version change", () => {
    localStorage.setItem("webkit_some_internal", "v");
    localStorage.setItem("my_other_key", "v");
    const report = runCacheJanitor("0.1.2");
    expect(report.ran).toBe(true);
    expect(report.removed).toEqual([]);
    expect(localStorage.getItem("webkit_some_internal")).toBe("v");
    expect(localStorage.getItem("my_other_key")).toBe("v");
  });
});
