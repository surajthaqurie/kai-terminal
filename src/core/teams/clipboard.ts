import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { windowsPowerShellEnv } from "../integrations/secretStore";
import { privateTempDir } from "./tempdir";

/**
 * Files and images on the OS clipboard, for the chat's Attach button and
 * Ctrl+V. (Kai Terminal's own paste pastes the same things as PATHS; this
 * lets the chat read them directly in any terminal.) A copied image is saved
 * as a PNG under the temp folder and returned by path.
 */

export interface RunResult {
  code: number | null;
  stdout: Buffer;
}
export type BinaryRunner = (
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv
) => Promise<RunResult>;

export const runBinary: BinaryRunner = (command, args, env) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: "buffer",
        env: env ?? process.env,
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 32 * 1024 * 1024,
      },
      (err, stdout) => {
        const code = err
          ? typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : null
          : 0;
        resolve({ code, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "") });
      }
    );
  });

const MAX_PATHS = 10;
const KEEP_MS = 24 * 60 * 60 * 1000;

function percentDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Absolute local paths from a `text/uri-list` payload (comments and non-file entries skipped). */
export function parseUriList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const rest = line.startsWith("file://localhost")
      ? line.slice(16)
      : line.startsWith("file://")
        ? line.slice(7)
        : null;
    if (rest === null) continue;
    const p = percentDecode(rest);
    if (p.startsWith("/")) out.push(p);
    if (out.length >= MAX_PATHS) break;
  }
  return out;
}

function pasteDir(): string {
  const dir = privateTempDir("kai-paste");
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^paste-\d+\.png$/.test(name)) continue;
      const file = path.join(dir, name);
      if (Date.now() - fs.statSync(file).mtimeMs > KEEP_MS) fs.rmSync(file, { force: true });
    }
  } catch {
    // cleanup is best effort
  }
  return dir;
}

export interface ClipboardDeps {
  platform?: NodeJS.Platform;
  run?: BinaryRunner;
  /** Where a pasted image is saved; default: the temp folder. */
  dir?: string;
  now?: () => number;
}

const WINDOWS_SCRIPT =
  "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;" +
  "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" +
  "$cb=[System.Windows.Forms.Clipboard];" +
  "if($cb::ContainsFileDropList()){foreach($f in $cb::GetFileDropList()){[Console]::Out.WriteLine($f)}}" +
  "elseif($cb::ContainsImage()){$cb::GetImage().Save($env:KAI_PASTE_PNG,[System.Drawing.Imaging.ImageFormat]::Png);[Console]::Out.WriteLine($env:KAI_PASTE_PNG)}";

/** Paths of copied files, or of a PNG saved from a copied image. Empty when there is neither. */
export async function readClipboardAttachments(deps: ClipboardDeps = {}): Promise<string[]> {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? runBinary;
  const dir = deps.dir ?? pasteDir();
  const png = path.join(dir, `paste-${(deps.now ?? Date.now)()}.png`);

  if (platform === "win32") {
    const r = await run(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_SCRIPT],
      windowsPowerShellEnv({ KAI_PASTE_PNG: png })
    );
    if (r.code !== 0) return [];
    return r.stdout
      .toString("utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, MAX_PATHS);
  }

  if (platform === "darwin") {
    const file = await run("osascript", ["-e", "POSIX path of (the clipboard as «class furl»)"]);
    const p = file.code === 0 ? file.stdout.toString("utf8").trim() : "";
    if (p.startsWith("/")) return [p];
    const saved = await run("osascript", [
      "-e",
      "on run argv",
      "-e",
      "set d to (the clipboard as «class PNGf»)",
      "-e",
      "set f to open for access (POSIX file (item 1 of argv)) with write permission",
      "-e",
      "set eof f to 0",
      "-e",
      "write d to f",
      "-e",
      "close access f",
      "-e",
      "end run",
      png,
    ]);
    return saved.code === 0 && fs.existsSync(png) ? [png] : [];
  }

  const tools: Array<[string, string[], string[], string[]]> = [
    ["wl-paste", ["--list-types"], ["--type", "text/uri-list"], ["--type", "image/png"]],
    [
      "xclip",
      ["-selection", "clipboard", "-t", "TARGETS", "-o"],
      ["-selection", "clipboard", "-t", "text/uri-list", "-o"],
      ["-selection", "clipboard", "-t", "image/png", "-o"],
    ],
  ];
  for (const [program, listArgs, uriArgs, imageArgs] of tools) {
    const types = await run(program, listArgs);
    if (types.code !== 0) continue;
    const has = (t: string) =>
      types.stdout
        .toString("utf8")
        .split(/\r?\n/)
        .some((l) => l.trim() === t);
    if (has("text/uri-list")) {
      const uri = await run(program, uriArgs);
      const paths = uri.code === 0 ? parseUriList(uri.stdout.toString("utf8")) : [];
      if (paths.length > 0) return paths;
    }
    if (has("image/png")) {
      const img = await run(program, imageArgs);
      if (img.code === 0 && img.stdout.length > 0) {
        fs.writeFileSync(png, img.stdout);
        return [png];
      }
    }
    return [];
  }
  return [];
}

/**
 * File paths in pasted text: words separated by spaces, with "double" or
 * 'single' quotes (and `\ ` on macOS/Linux) keeping spaces inside one path.
 */
export function splitPastedPaths(text: string, windows = process.platform === "win32"): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let started = false;
  const push = () => {
    if (started && cur) out.push(cur);
    cur = "";
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (!windows && c === "\\" && i + 1 < text.length && text[i + 1] === " ") {
      cur += " ";
      started = true;
      i++;
    } else if (/\s/.test(c)) {
      push();
    } else {
      cur += c;
      started = true;
    }
  }
  push();
  return out;
}
