import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * SEC-04: app commands are gated per window by Tauri's ACL.
 *
 * `build.rs` declares the app commands (`APP_COMMANDS`), which switches the ACL
 * on for them: from then on a window may call a command only if its capability
 * file grants `allow-<command>`. Two ways this can go wrong, both caught here:
 *   - a command in `generate_handler!` is missing from `APP_COMMANDS` or from the
 *     main window's capability: it is rejected for EVERY window (the app breaks);
 *   - a secondary window (music mini-player, popped-out chat; both embed
 *     third-party content) is granted more than it needs, e.g. `create_pty`.
 */
const TAURI = path.resolve(__dirname, "../../src-tauri");
const read = (rel: string) => fs.readFileSync(path.join(TAURI, rel), "utf8");
const permissionFor = (command: string) => `allow-${command.replace(/_/g, "-")}`;

function handlerCommands(): string[] {
  const lib = read("src/lib.rs");
  const block = /generate_handler!\[([\s\S]*?)\]\)/.exec(lib);
  if (!block) throw new Error("generate_handler! block not found in lib.rs");
  return block[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split("::").pop() as string);
}

function manifestCommands(): string[] {
  const build = read("build.rs");
  const block = /const APP_COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/.exec(build);
  if (!block) throw new Error("APP_COMMANDS not found in build.rs");
  return [...block[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
}

function capability(file: string): { windows: string[]; permissions: string[] } {
  return JSON.parse(read(`capabilities/${file}`));
}

/** The app-command permissions (`allow-*`, not the `core:*` plugin ones) a capability grants. */
const appPermissions = (permissions: string[]) => permissions.filter((p) => !p.includes(":"));

describe("app command ACL", () => {
  it("build.rs declares exactly the commands lib.rs registers", () => {
    const handlers = handlerCommands();
    const declared = manifestCommands();
    expect(new Set(handlers).size).toBe(handlers.length); // no duplicates
    expect([...declared].sort()).toEqual([...handlers].sort());
  });

  it("the terminal windows (main, term-*) are granted every command", () => {
    const cap = capability("default.json");
    expect(cap.windows).toEqual(["main", "term-*"]);
    expect(appPermissions(cap.permissions).sort()).toEqual(
      manifestCommands().map(permissionFor).sort()
    );
  });

  it("the music mini-player gets only what it uses", () => {
    const cap = capability("music-pip.json");
    expect(cap.windows).toEqual(["music-pip"]);
    expect(appPermissions(cap.permissions).sort()).toEqual(
      ["close_music_pip", "music_relay_url"].map(permissionFor).sort()
    );
  });

  it("the popped-out Shared Agent chat gets only what it uses", () => {
    const cap = capability("shared-chat.json");
    expect(cap.windows).toEqual(["shared-chat"]);
    expect(appPermissions(cap.permissions).sort()).toEqual(
      ["shared_agent_request_cmd", "shared_agent_stop_cmd", "close_shared_chat_window"]
        .map(permissionFor)
        .sort()
    );
  });

  it("no secondary window can start a process, install an update or rewrite agent config", () => {
    const sensitive = [
      "create_pty",
      "write_to_pty",
      "close_pty",
      "resize_pty",
      "pty_busy_sessions",
      "open_terminal_window",
      "run_integration_rpc_cmd",
      "setup_agent_mcp_cmd",
      "check_ai_cli_path",
      "download_update_asset_cmd",
      "launch_update_installer_cmd",
      "open_project_in_editor",
      "read_clipboard_attachments_cmd",
      "run_git_action_cmd",
    ].map(permissionFor);
    for (const file of ["music-pip.json", "shared-chat.json"]) {
      const granted = new Set(capability(file).permissions);
      for (const permission of sensitive) {
        expect(granted.has(permission), `${file} must not grant ${permission}`).toBe(false);
      }
    }
  });

  it("every window label that exists has a capability, and no capability covers two classes", () => {
    const files = fs
      .readdirSync(path.join(TAURI, "capabilities"))
      .filter((f) => f.endsWith(".json"));
    expect(files.sort()).toEqual(["default.json", "music-pip.json", "shared-chat.json"]);
    const labels = files.flatMap((f) => capability(f).windows);
    expect(new Set(labels).size).toBe(labels.length); // a label belongs to exactly one capability
  });
});
