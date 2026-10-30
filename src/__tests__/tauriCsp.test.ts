import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Regression guard for the Windows release "stuck terminal".
 *
 * Tauri v2 performs IPC over fetch to `http://ipc.localhost` (with the
 * `ipc:` scheme for the bridge). A CSP without an explicit `connect-src`
 * falls back to `default-src 'self'`, the WebView blocks EVERY invoke /
 * event-listen call, and the terminal can never spawn a shell or receive
 * output. Data-URI SVG icons additionally need `img-src ... data:`.
 * This test fails the build if the policy ever drops those entries again.
 */
function loadCsp(): string {
  const confPath = resolve(process.cwd(), "src-tauri", "tauri.conf.json");
  const raw = readFileSync(confPath, "utf8");
  const parsed = JSON.parse(raw) as { app?: { security?: { csp?: string } } };
  return parsed.app?.security?.csp ?? "";
}

describe("tauri.conf.json Content Security Policy", () => {
  const csp = loadCsp();

  it("defines a CSP", () => {
    expect(csp.trim().length).toBeGreaterThan(0);
  });

  it("allows the Tauri IPC transport (invoke + event listen)", () => {
    expect(csp).toMatch(/connect-src[^;]*/);
    expect(csp).toContain("ipc:");
    expect(csp).toContain("http://ipc.localhost");
  });

  it("allows data-URI images (bundled SVG icons)", () => {
    expect(csp).toMatch(/img-src[^;]*data:/);
  });

  it("allows the GitHub Releases API (update checks run in the WebView)", () => {
    // The update check is a frontend `fetch` to api.github.com. Without an
    // explicit allow-list entry the WebView blocks it on every OS and the
    // check silently resolves to "no update" — the "check for updates does
    // nothing in the installed app" report.
    const connectSrc = csp.match(/connect-src([^;]*)/)?.[1] ?? "";
    expect(connectSrc).toContain("https://api.github.com");
  });

  it("keeps scripts locked down (no wildcards, no unsafe-inline)", () => {
    const scriptSrc = csp.match(/script-src([^;]*)/)?.[1] ?? "";
    expect(scriptSrc).not.toContain("*");
    expect(scriptSrc).not.toContain("unsafe-inline");
  });
});

describe("frameless window (custom title bar) config", () => {
  const read = (name: string) =>
    JSON.parse(readFileSync(resolve(process.cwd(), "src-tauri", name), "utf8"));

  it("drops native decorations on Windows/Linux and grants the window permissions the tab bar uses", () => {
    const conf = read("tauri.conf.json");
    expect(conf.app.windows[0].decorations).toBe(false);
    const caps = read("capabilities/default.json").permissions as string[];
    for (const p of [
      "core:window:allow-minimize",
      "core:window:allow-toggle-maximize",
      "core:window:allow-is-maximized",
      "core:window:allow-start-dragging",
    ]) {
      expect(caps).toContain(p);
    }
  });

  it("keeps native traffic lights on macOS via an overlay title bar", () => {
    const win = read("tauri.macos.conf.json").app.windows[0];
    expect(win.label).toBe("main");
    expect(win.decorations).toBe(true);
    expect(win.titleBarStyle).toBe("Overlay");
  });
});
