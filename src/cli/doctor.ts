import path from "path";
import fs from "fs";
import os from "os";
import { getKaiHomeDir } from "../core/registry";
import { KAI_VERSION } from "./constants";
import { findKaiAppBinary, isKaiCliShim } from "./desktopApp";

/** One app-drawer entry audit (Linux .desktop file). */
export interface DesktopEntryAudit {
  file: string;
  name: string | null;
  execLine: string | null;
  execTarget: string | null;
  execFound: boolean;
  /** True when Exec resolves to the Node CLI shim instead of the GUI — the
   * shim prints help on a drawer click and the app appears to never open. */
  execIsCliShim: boolean;
  icon: string | null;
  iconFound: boolean;
}

/**
 * Parse the [Desktop Entry] section of a .desktop file into lowercased
 * keys. Ignores other sections, comments, and blank lines.
 */
export function parseDesktopEntry(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inSection = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      inSection = line.slice(1, -1).trim().toLowerCase() === "desktop entry";
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    if (!(key in out)) out[key] = line.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Resolve the executable an Exec= line points at: first token, quotes and
 * %-field-codes stripped, then an absolute-path stat or a PATH lookup.
 * Returns null when no usable target can be determined.
 */
export function resolveExecTarget(execLine: string): string | null {
  const m = execLine.trim().match(/^("([^"]+)"|'([^']+)'|(\S+))/);
  const target = (m?.[2] ?? m?.[3] ?? m?.[4] ?? "").trim();
  if (!target || target === "%f" || target === "%F" || target.startsWith("%")) return null;
  // Field codes may trail the binary (`Exec=app %F`): only the head matters.
  const head = target.split(/\s+/)[0] ?? "";
  if (!head) return null;
  if (path.isAbsolute(head)) {
    try {
      if (fs.existsSync(head) && fs.statSync(head).isFile()) return head;
    } catch {
      // treat as missing below
    }
    return null;
  }
  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    try {
      const c = path.join(dir, head);
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      // keep probing
    }
  }
  return null;
}

function iconLookupDirs(): string[] {
  const dirs: string[] = ["/usr/share/pixmaps"];
  const hicolor = "/usr/share/icons/hicolor";
  for (const size of ["256x256", "128x128", "64x64", "48x48", "32x32", "scalable"]) {
    dirs.push(path.join(hicolor, size, "apps"));
  }
  const home = os.homedir();
  if (home) dirs.push(path.join(home, ".local", "share", "icons", "hicolor", "128x128", "apps"));
  return dirs;
}

/** Audit one .desktop file; null when unreadable or not a desktop entry. */
export function auditDesktopFile(file: string): DesktopEntryAudit | null {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  if (content.length > 64 * 1024) return null;
  const entry = parseDesktopEntry(content);
  if (!entry["type"] && !entry["name"] && !entry["exec"]) return null;
  const execLine = entry["exec"] ?? null;
  const execTarget = execLine ? resolveExecTarget(execLine) : null;
  const icon = entry["icon"] ?? null;
  let iconFound = false;
  if (icon) {
    if (icon.includes("/")) {
      try {
        iconFound = fs.existsSync(icon) && fs.statSync(icon).isFile();
      } catch {
        iconFound = false;
      }
    } else {
      for (const dir of iconLookupDirs()) {
        for (const ext of [".png", ".svg", ".xpm", ""]) {
          try {
            if (fs.existsSync(path.join(dir, icon + ext))) {
              iconFound = true;
              break;
            }
          } catch {
            // keep probing
          }
        }
        if (iconFound) break;
      }
    }
  }
  return {
    file,
    name: entry["name"] ?? null,
    execLine,
    execTarget,
    execFound: execTarget !== null,
    execIsCliShim: execTarget !== null && isKaiCliShim(execTarget),
    icon,
    iconFound,
  };
}

/**
 * Find installed *.desktop files mentioning kai (case-insensitive Name,
 * Exec, or filename). Linux only — other OSes return [].
 */
function findKaiDesktopFiles(): string[] {
  if (process.platform !== "linux") return [];
  const dirs = [
    "/usr/share/applications",
    "/usr/local/share/applications",
    path.join(os.homedir(), ".local", "share", "applications"),
  ];
  const found: string[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.toLowerCase().endsWith(".desktop")) continue;
      const file = path.join(dir, name);
      if (
        name.toLowerCase().includes("kai") ||
        (() => {
          try {
            const head = fs.readFileSync(file, "utf-8").slice(0, 4096).toLowerCase();
            return head.includes("kai");
          } catch {
            return false;
          }
        })()
      ) {
        found.push(file);
      }
    }
  }
  return found.sort();
}

/** Print the `kai doctor` diagnostics report (stdout only, exit 0). */
export function printDoctorReport(): void {
  console.log(`[kai] Doctor — environment & install diagnostics (kai v${KAI_VERSION})`);
  console.log(`  Platform:          ${process.platform}/${process.arch} (node ${process.version})`);
  console.log(`  KAI_HOME:          ${getKaiHomeDir()}`);
  const appBinary = findKaiAppBinary();
  console.log(
    appBinary
      ? `  Desktop app binary: ${appBinary}`
      : `  Desktop app binary: NOT FOUND on disk or PATH`
  );
  if (!appBinary) {
    console.log(`    └─ Install the desktop .exe/.msi/.deb/.dmg, or run from source.`);
  }

  if (process.platform === "linux") {
    const files = findKaiDesktopFiles();
    console.log(`  Linux app-drawer entries mentioning kai: ${files.length}`);
    if (files.length === 0) {
      console.log(`    └─ No .desktop entry found: reinstall the .deb or check PATH.`);
    }
    for (const file of files) {
      const audit = auditDesktopFile(file);
      if (!audit) {
        console.log(`    - ${file} (unreadable, skipped)`);
        continue;
      }
      const execMark = audit.execFound ? "✓" : "✗";
      const iconMark = audit.iconFound ? "✓" : "✗";
      console.log(`    - ${file}`);
      console.log(`      Name: ${audit.name ?? "(missing)"}`);
      console.log(
        `      Exec: ${audit.execLine ?? "(missing)"} ${execMark}` +
          (audit.execTarget
            ? ` -> ${audit.execTarget}`
            : ` -> target NOT FOUND (drawer click will do nothing)`)
      );
      console.log(`      Icon: ${audit.icon ?? "(missing)"} ${iconMark}`);
      if (audit.execIsCliShim) {
        console.log(
          `      └─ Fix: Exec resolves to the Node CLI shim (${audit.execTarget}), ` +
            `not the GUI. Recent CLI versions open the app on a bare, ` +
            `non-TTY launch, but the .desktop should ideally point at the ` +
            `GUI binary directly (absolute path) — report this to the Kai packagers.`
        );
      }
      if (!audit.execFound) {
        console.log(
          `      └─ Fix: verify the installed binary path, then reinstall the .deb. ` +
            `Run the binary directly in a terminal to see the real error.`
        );
      }
      if (!audit.iconFound) {
        console.log(`      └─ Fix: reinstall the .deb so /usr/share/icons entries are restored.`);
      }
    }
  } else {
    console.log(`  App-drawer audit: Linux only (skipped on ${process.platform}).`);
  }
}
