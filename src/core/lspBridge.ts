import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { resolveCanonicalPath } from "./registry";

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

  try {
    const checkCmd = isWindows ? `where.exe "${command}"` : `which "${command}"`;
    execSync(checkCmd, { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
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
export function findLspServerForLanguage(language: string): LspServerCatalogEntry | null {
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
export function encodeLspMessage(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  const length = Buffer.byteLength(json, "utf-8");
  return `Content-Length: ${length}\r\n\r\n${json}`;
}

/**
 * Parse an LSP JSON-RPC response buffer
 */
export function decodeLspMessage(raw: string): Record<string, unknown> | null {
  const separator = "\r\n\r\n";
  const sepIndex = raw.indexOf(separator);
  if (sepIndex === -1) return null;

  const header = raw.slice(0, sepIndex);
  const match = header.match(/Content-Length:\s*(\d+)/i);
  if (!match) return null;

  const length = parseInt(match[1], 10);
  const bodyStart = sepIndex + separator.length;
  const remaining = raw.slice(bodyStart);
  if (Buffer.byteLength(remaining, "utf-8") < length) {
    return null;
  }

  const body = Buffer.from(remaining, "utf-8").subarray(0, length).toString("utf-8");
  try {
    return JSON.parse(body);
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
      let responseBuffer = "";

      proc.stdout?.on("data", (chunk: Buffer) => {
        responseBuffer += chunk.toString("utf-8");

        while (true) {
          const separator = "\r\n\r\n";
          const sepIndex = responseBuffer.indexOf(separator);
          if (sepIndex === -1) break;

          const header = responseBuffer.slice(0, sepIndex);
          const match = header.match(/Content-Length:\s*(\d+)/i);
          if (!match) {
            responseBuffer = responseBuffer.slice(sepIndex + separator.length);
            continue;
          }

          const length = parseInt(match[1], 10);
          const bodyStart = sepIndex + separator.length;
          const remaining = responseBuffer.slice(bodyStart);
          if (Buffer.byteLength(remaining, "utf-8") < length) {
            break; // Wait for full message body
          }

          const body = Buffer.from(remaining, "utf-8").subarray(0, length).toString("utf-8");
          const consumedLength =
            Buffer.byteLength(responseBuffer.slice(0, bodyStart), "utf-8") + length;
          const fullBuf = Buffer.from(responseBuffer, "utf-8");
          responseBuffer = fullBuf.subarray(consumedLength).toString("utf-8");

          let parsed: Record<string, unknown> | null = null;
          try {
            parsed = JSON.parse(body);
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

              const rawResult = parsed.result;
              const defs: LspReferenceLocation[] = [];

              if (Array.isArray(rawResult)) {
                for (const loc of rawResult) {
                  if (loc && loc.uri && loc.range) {
                    const filePath = loc.uri.replace("file://", "");
                    defs.push({
                      uri: loc.uri,
                      filePath: path.relative(canonicalRoot, filePath).replace(/\\/g, "/"),
                      range: loc.range,
                    });
                  }
                }
              } else if (
                rawResult &&
                typeof rawResult === "object" &&
                (rawResult as Record<string, unknown>).uri &&
                (rawResult as Record<string, unknown>).range
              ) {
                const loc = rawResult as {
                  uri: string;
                  range: {
                    start: { line: number; character: number };
                    end: { line: number; character: number };
                  };
                };
                const filePath = loc.uri.replace("file://", "");
                defs.push({
                  uri: loc.uri,
                  filePath: path.relative(canonicalRoot, filePath).replace(/\\/g, "/"),
                  range: loc.range,
                });
              }

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

      // Send initialize request
      const fileUri = `file://${fullPath}`;
      const initReq = encodeLspMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          processId: process.pid,
          rootUri: `file://${canonicalRoot}`,
          capabilities: {},
        },
      });

      proc.stdin?.write(initReq);
    } catch (err: unknown) {
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
          error: String(err),
        });
      }
    }
  });
}
