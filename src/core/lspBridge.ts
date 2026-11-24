import { spawn, exec, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { resolveCanonicalPath } from "./registry";
import { noCwdLookupEnv } from "./spawnSafety";

export interface LspServerCatalogEntry {
  language: string;
  command: string;
  args: string[];
  description: string;
  installHint: string;
}

export const KNOWN_LSP_SERVERS: LspServerCatalogEntry[] = [
  {
    language: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    description: "TypeScript Language Server (TSServer wrapper)",
    installHint: "npm install -g typescript-language-server typescript",
  },
  {
    language: "rust",
    command: "rust-analyzer",
    args: [],
    description: "Rust Analyzer language server",
    installHint: "rustup component add rust-analyzer",
  },
  {
    language: "python",
    command: "pyright-langserver",
    args: ["--stdio"],
    description: "Pyright language server for Python",
    installHint: "npm install -g pyright",
  },
  {
    language: "go",
    command: "gopls",
    args: [],
    description: "Go language server",
    installHint: "go install golang.org/x/tools/gopls@latest",
  },
];

export interface DetectedLspServer {
  language: string;
  command: string;
  isAvailable: boolean;
  version?: string;
  installHint?: string;
}

export interface LspReferenceLocation {
  uri: string;
  filePath: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export interface LspCrossFileReferenceResult {
  symbolName: string;
  language: string;
  serverUsed: string;
  references: LspReferenceLocation[];
  definitions: LspReferenceLocation[];
  isAvailable: boolean;
  degradedMode?: boolean;
  degradedReason?: string;
  error?: string;
}

/**
 * Check whether a binary command exists in the system PATH
 */
export function isCommandAvailable(command: string): boolean {
  if (!/^[a-zA-Z0-9_-]+$/.test(command)) {
    return false;
  }
  if (command === "node") {
    return true;
  }

  const isWindows = process.platform === "win32";
  const envPath = process.env.PATH || process.env.Path || "";
  const exts = isWindows
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase())
    : [""];

  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(
        dir,
        isWindows && command.toLowerCase().endsWith(ext) ? command : command + ext
      );
      try {
        if (fs.existsSync(candidate)) {
          const stat = fs.statSync(candidate);
          if (stat.isFile()) {
            return true;
          }
        }
      } catch {
        // ignore access errors
      }
    }
  }

  // The PATH walk above is complete on Windows (PATHEXT included). `where.exe`
  // would also list a same-named file in the current (project) directory, so it
  // is not used there as a fallback.
  if (isWindows) return false;
  try {
    execSync(`which "${command}"`, { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/** `<command> --version`, asynchronously (never blocks the event loop). */
function probeLspVersion(command: string): Promise<string> {
  return new Promise((resolve) => {
    exec(
      `${command} --version`,
      {
        encoding: "utf-8",
        timeout: 2000,
        // Never run a same-named file from the project directory (Windows).
        env: noCwdLookupEnv(),
        windowsHide: true,
      },
      (error, stdout) => resolve(error ? "detected" : String(stdout).trim().split("\n")[0])
    );
  });
}

/**
 * Detect all installed language servers, probing every installed one at the same
 * time without blocking the event loop. Installed servers are probed through the shell
 * exactly as the synchronous version does; the commands come from the fixed catalog.
 */
export async function detectInstalledLspServersAsync(): Promise<DetectedLspServer[]> {
  return Promise.all(
    KNOWN_LSP_SERVERS.map(async (entry): Promise<DetectedLspServer> => {
      const available = isCommandAvailable(entry.command);
      return {
        language: entry.language,
        command: entry.command,
        isAvailable: available,
        version: available ? await probeLspVersion(entry.command) : undefined,
        installHint: available ? undefined : entry.installHint,
      };
    })
  );
}

/** How long a detection result is reused: servers are installed rarely. */
export const LSP_DETECTION_TTL_MS = 5 * 60 * 1000;
let lspDetection: { at: number; value: DetectedLspServer[] } | null = null;
let lspDetectionInFlight: Promise<DetectedLspServer[]> | null = null;

/** [`detectInstalledLspServersAsync`] remembered for [`LSP_DETECTION_TTL_MS`]; concurrent calls share one probe. */
export function detectInstalledLspServersCached(
  now: number = Date.now()
): Promise<DetectedLspServer[]> {
  if (lspDetection && now - lspDetection.at < LSP_DETECTION_TTL_MS) {
    return Promise.resolve(lspDetection.value);
  }
  lspDetectionInFlight ??= detectInstalledLspServersAsync()
    .then((value) => {
      lspDetection = { at: now, value };
      return value;
    })
    .finally(() => {
      lspDetectionInFlight = null;
    });
  return lspDetectionInFlight;
}

/** Forgets the remembered detection (tests, or after the user installs a server). */
export function resetLspDetectionCache(): void {
  lspDetection = null;
  lspDetectionInFlight = null;
}

/**
 * Detect all installed language servers on the local machine
 */
export function detectInstalledLspServers(): DetectedLspServer[] {
  const results: DetectedLspServer[] = [];

  for (const entry of KNOWN_LSP_SERVERS) {
    const available = isCommandAvailable(entry.command);
    let version: string | undefined;

    if (available) {
      try {
        const out = execSync(`${entry.command} --version`, {
          encoding: "utf-8",
          timeout: 2000,
          stdio: ["ignore", "pipe", "ignore"],
          // Never run a same-named file from the project directory (Windows).
          env: noCwdLookupEnv(),
        });
        version = out.trim().split("\n")[0];
      } catch {
        version = "detected";
      }
    }

    results.push({
      language: entry.language,
      command: entry.command,
      isAvailable: available,
      version,
      installHint: available ? undefined : entry.installHint,
    });
  }

  return results;
}

/**
 * Find the primary matching language server for a project
 */
function findLspServerForLanguage(language: string): LspServerCatalogEntry | null {
  const norm = language.toLowerCase();
  for (const entry of KNOWN_LSP_SERVERS) {
    if (entry.language === norm) {
      if (isCommandAvailable(entry.command)) {
        return entry;
      }
    }
  }
  return null;
}

/**
 * Format LSP JSON-RPC message with Content-Length header
 */
/** A JSON-RPC message is an object; anything else is treated as unreadable. */
function jsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function encodeLspMessage(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  const length = Buffer.byteLength(json, "utf-8");
  return `Content-Length: ${length}\r\n\r\n${json}`;
}

/**
 * The locations in a `textDocument/definition` result (a Location, a list of them, or null),
 * with each path relative to `root`. Entries without a string `uri` and a `range` are skipped:
 * the server is another program, so its output is checked rather than trusted.
 */
export function definitionLocations(result: unknown, root: string): LspReferenceLocation[] {
  const items: unknown[] = Array.isArray(result) ? result : result ? [result] : [];
  const out: LspReferenceLocation[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const { uri, range } = item as { uri?: unknown; range?: unknown };
    if (typeof uri !== "string" || !range || typeof range !== "object") continue;
    let filePath: string;
    try {
      // `file:///C:/a%20b.ts` is `C:\a b.ts` on Windows; a plain string cut left `/C:/a%20b.ts`.
      filePath = uri.startsWith("file:") ? fileURLToPath(uri) : uri;
    } catch {
      continue; // a file URI for another platform (e.g. a UNC host on POSIX)
    }
    out.push({
      uri,
      filePath: path.relative(root, filePath).replace(/\\/g, "/"),
      range: range as LspReferenceLocation["range"],
    });
  }
  return out;
}

/**
 * Parse an LSP JSON-RPC response buffer
 */
export function decodeLspMessage(raw: string): Record<string, unknown> | null {
  const separator = "\r\n\r\n";
  const sepIndex = raw.indexOf(separator);
  if (sepIndex === -1) return null;

  const header = raw.slice(0, sepIndex);
  const match = /Content-Length:\s*(\d+)/i.exec(header);
  if (!match) return null;

  const length = parseInt(match[1], 10);
  const bodyStart = sepIndex + separator.length;
  const remaining = raw.slice(bodyStart);
  if (Buffer.byteLength(remaining, "utf-8") < length) {
    return null;
  }

  const body = Buffer.from(remaining, "utf-8").subarray(0, length).toString("utf-8");
  try {
    return jsonObject(JSON.parse(body));
  } catch {
    return null;
  }
}

/**
 * Perform a bounded LSP cross-file reference lookup if a language server is installed.
 * If no server is installed or available, safely falls back with zero crashes.
 */
export async function queryLspCrossFileReferences(
  projectRoot: string,
  relativeFilePath: string,
  line: number,
  character: number,
  symbolName: string,
  timeoutMs: number = 4000
): Promise<LspCrossFileReferenceResult> {
  const canonicalRoot = resolveCanonicalPath(projectRoot);
  const fullPath = path.join(canonicalRoot, relativeFilePath);

  const ext = path.extname(relativeFilePath).toLowerCase();
  let targetLang = "typescript";
  if (ext === ".rs") targetLang = "rust";
  else if (ext === ".py") targetLang = "python";
  else if (ext === ".go") targetLang = "go";

  const server = findLspServerForLanguage(targetLang);

  if (!server) {
    const hint =
      KNOWN_LSP_SERVERS.find((k) => k.language === targetLang)?.installHint || "package manager";
    return {
      symbolName,
      language: targetLang,
      serverUsed: "none",
      references: [],
      definitions: [],
      isAvailable: false,
      degradedMode: true,
      degradedReason: `No local language server for "${targetLang}" found in PATH. Code intelligence running in degraded mode (syntax-only fallback). Install server via: ${hint}`,
      error: `No local language server for "${targetLang}" found in PATH. Install with: ${hint}`,
    };
  }

  // Attempt communication with LSP process
  return new Promise((resolve) => {
    let hasResolved = false;
    let proc: ReturnType<typeof spawn> | null = null;

    const timer = setTimeout(() => {
      if (!hasResolved) {
        hasResolved = true;
        if (proc) {
          try {
            proc.kill();
          } catch {
            // ignore
          }
        }
        resolve({
          symbolName,
          language: targetLang,
          serverUsed: server.command,
          references: [],
          definitions: [],
          isAvailable: true,
          degradedMode: true,
          degradedReason: `LSP request timed out after ${timeoutMs}ms; operating in degraded mode`,
          error: `LSP request timed out after ${timeoutMs}ms`,
        });
      }
    }, timeoutMs);

    try {
      proc = spawn(server.command, server.args, {
        cwd: canonicalRoot,
        stdio: ["pipe", "pipe", "ignore"],
      });

      let step: "init" | "ready" | "done" = "init";
      // Byte-level framing: LSP `Content-Length` counts BYTES, so the buffer
      // must stay a Buffer. Decoding chunks to strings corrupts multibyte
      // characters split across chunk boundaries and forced several full
      // re-encodes of the whole buffer per message.
      let responseBuffer: Buffer = Buffer.alloc(0);
      const MAX_LSP_BUFFER_BYTES = 8 * 1024 * 1024;

      proc.stdout?.on("data", (chunk: Buffer) => {
        responseBuffer =
          responseBuffer.length === 0 ? chunk : Buffer.concat([responseBuffer, chunk]);
        if (responseBuffer.length > MAX_LSP_BUFFER_BYTES) {
          // Runaway server output: drop it rather than grow without bound;
          // the request timeout resolves the call in degraded mode.
          responseBuffer = Buffer.alloc(0);
          return;
        }

        while (true) {
          const sepIndex = responseBuffer.indexOf("\r\n\r\n");
          if (sepIndex === -1) break;

          const header = responseBuffer.subarray(0, sepIndex).toString("utf-8");
          const match = /Content-Length:\s*(\d+)/i.exec(header);
          const bodyStart = sepIndex + 4;
          if (!match) {
            responseBuffer = responseBuffer.subarray(bodyStart);
            continue;
          }

          const length = parseInt(match[1], 10);
          if (responseBuffer.length - bodyStart < length) {
            break; // Wait for full message body
          }

          const body = responseBuffer.subarray(bodyStart, bodyStart + length).toString("utf-8");
          responseBuffer = responseBuffer.subarray(bodyStart + length);

          let parsed: Record<string, unknown> | null;
          try {
            parsed = jsonObject(JSON.parse(body));
          } catch {
            continue;
          }

          if (!parsed) continue;

          if (step === "init" && parsed.id === 1) {
            step = "ready";
            // 1. Send initialized notification
            const initNotification = encodeLspMessage({
              jsonrpc: "2.0",
              method: "initialized",
              params: {},
            });
            proc?.stdin?.write(initNotification);

            // 2. Send definition request
            const defReq = encodeLspMessage({
              jsonrpc: "2.0",
              id: 2,
              method: "textDocument/definition",
              params: {
                textDocument: { uri: fileUri },
                position: { line: Math.max(0, line - 1), character },
              },
            });
            proc?.stdin?.write(defReq);
          } else if (parsed.id === 2) {
            step = "done";
            clearTimeout(timer);
            if (!hasResolved) {
              hasResolved = true;
              try {
                proc?.kill();
              } catch {
                // ignore
              }

              const defs = definitionLocations(parsed.result, canonicalRoot);

              resolve({
                symbolName,
                language: targetLang,
                serverUsed: server.command,
                references: defs,
                definitions: defs,
                isAvailable: true,
                degradedMode: false,
              });
            }
            break;
          }
        }
      });

      proc.on("error", (err: Error) => {
        clearTimeout(timer);
        if (!hasResolved) {
          hasResolved = true;
          resolve({
            symbolName,
            language: targetLang,
            serverUsed: server.command,
            references: [],
            definitions: [],
            isAvailable: false,
            degradedMode: true,
            degradedReason: `Failed to spawn ${server.command}: ${err.message}`,
            error: `Failed to spawn ${server.command}: ${err.message}`,
          });
        }
      });

      proc.on("close", (code, signal) => {
        clearTimeout(timer);
        if (!hasResolved) {
          hasResolved = true;
          const exitReason = signal
            ? `terminated with signal ${signal}`
            : `exited with code ${code ?? 0}`;
          resolve({
            symbolName,
            language: targetLang,
            serverUsed: server.command,
            references: [],
            definitions: [],
            isAvailable: true,
            degradedMode: true,
            degradedReason: `LSP server ${server.command} ${exitReason} before responding; operating in degraded mode`,
            error: `LSP server ${server.command} ${exitReason} before responding`,
          });
        }
      });

      // Send initialize request
      const fileUri = pathToFileURL(fullPath).href;
      const initReq = encodeLspMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          processId: process.pid,
          rootUri: pathToFileURL(canonicalRoot).href,
          capabilities: {},
        },
      });

      proc.stdin?.write(initReq);
    } catch (err: unknown) {
      clearTimeout(timer);
      if (!hasResolved) {
        hasResolved = true;
        const message = err instanceof Error ? err.message : String(err);
        resolve({
          symbolName,
          language: targetLang,
          serverUsed: server.command,
          references: [],
          definitions: [],
          isAvailable: false,
          degradedMode: true,
          degradedReason: `Failed to start ${server.command}: ${message}; operating in degraded mode`,
          error: String(err),
        });
      }
    }
  });
}
