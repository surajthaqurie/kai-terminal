import readline from "readline";
import { Transform } from "stream";
import fs from "fs";
import path from "path";
import {
  registerProject,
  loadProjectIndex,
  resolveCanonicalPath,
  isWithinProjectBoundary,
} from "./registry";
import { indexProject, isSensitiveFile } from "./indexer";
import { assembleContext } from "./contextAssembler";
import { retrieveContext } from "./retrieval";
import { recordMetric } from "./telemetry";
import { detectInstalledLspServers } from "./lspBridge";
import type { TaskCategory } from "./types";
import packageJson from "../../package.json";

export interface McpRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export const MCP_TOOLS = [
  {
    name: "kai_project_info",
    description:
      "Retrieve high-level project metadata, language breakdown, file count, and index status.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: {
          type: "string",
          description: "Optional path to the project root. Defaults to current working directory.",
        },
      },
    },
  },
  {
    name: "kai_search_code",
    description: "Perform deterministic search over indexed code files, symbols, and snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keywords or phrases." },
        limit: { type: "number", description: "Max number of files to return (1-20)." },
        projectPath: { type: "string", description: "Optional project root path." },
      },
      required: ["query"],
    },
  },
  {
    name: "kai_find_symbol",
    description:
      "Locate symbol definitions (functions, classes, interfaces) with line numbers and signatures.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Symbol name to search for." },
        projectPath: { type: "string", description: "Optional project root path." },
      },
      required: ["name"],
    },
  },
  {
    name: "kai_get_dependencies",
    description: "Query module dependencies and import graphs for a given file.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Relative path to the file inside the project." },
        projectPath: { type: "string", description: "Optional project root path." },
      },
      required: ["filePath"],
    },
  },
  {
    name: "kai_get_context",
    description:
      "Assemble a task-optimized context package with ranked sources, rules, and skills within a strict token budget.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task description or query from user." },
        categoryOverride: {
          type: "string",
          enum: [
            "explain",
            "implement",
            "debug",
            "refactor",
            "test",
            "review",
            "architecture",
            "documentation",
          ],
          description: "Optional explicit task category override.",
        },
        tokenBudget: {
          type: "number",
          description: "Maximum tokens for context package (default: 4000).",
        },
        projectPath: { type: "string", description: "Optional project root path." },
      },
      required: ["task"],
    },
  },
  {
    name: "kai_refresh_index",
    description: "Trigger a safe, bounded incremental re-index of the project.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "Optional project root path." },
        forceRebuild: {
          type: "boolean",
          description: "Force full rebuild instead of incremental update.",
        },
      },
    },
  },
  {
    name: "kai_strip_coauthors",
    description:
      "Remove AI-agent Co-authored-by trailers from recent commit messages. Fail-closed: requires a clean tree and unpushed history unless force is set. File content is never altered, messages only.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "Optional project root path." },
        last: {
          type: "number",
          description: "How many commits back from HEAD to process (default: 1, max: 50).",
        },
        match: {
          type: "string",
          description:
            "Optional case-insensitive substring: only strip trailer lines containing it.",
        },
        dryRun: {
          type: "boolean",
          description: "Preview the stripped messages without rewriting history.",
        },
        force: {
          type: "boolean",
          description: "Allow rewriting commits already pushed upstream.",
        },
      },
    },
  },
  {
    name: "kai_get_lsp_status",
    description:
      "Detect installed local Language Server Protocol (LSP) servers for cross-file type references.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "Optional project root path." },
      },
    },
  },
];

/**
 * Handle incoming MCP JSON-RPC messages and return the JSON-RPC response
 */
export async function handleMcpMessage(
  message: unknown,
  defaultProjectRoot: string = process.cwd(),
  cancelledRequests?: Set<string | number>
): Promise<McpResponse | null> {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request: expected JSON-RPC object" },
    };
  }

  const req = message as Record<string, unknown>;

  if (
    req.id !== undefined &&
    typeof req.id !== "string" &&
    typeof req.id !== "number" &&
    req.id !== null
  ) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request: id must be a string, number, or null" },
    };
  }

  const reqId =
    typeof req.id === "string" || typeof req.id === "number" || req.id === null ? req.id : null;

  if (req.jsonrpc !== "2.0") {
    return {
      jsonrpc: "2.0",
      id: reqId,
      error: { code: -32600, message: "Invalid Request: jsonrpc must be '2.0'" },
    };
  }

  if (typeof req.method !== "string" || !req.method.trim()) {
    return {
      jsonrpc: "2.0",
      id: reqId,
      error: { code: -32600, message: "Invalid Request: method must be a non-empty string" },
    };
  }

  const method = req.method.trim();

  // Handle cancellation notifications
  if (method === "notifications/cancelled" || method === "$/cancelRequest") {
    if (
      cancelledRequests &&
      typeof req.params === "object" &&
      req.params !== null &&
      !Array.isArray(req.params)
    ) {
      const p = req.params as Record<string, unknown>;
      const targetId = p.requestId ?? p.id;
      if (typeof targetId === "string" || typeof targetId === "number") {
        cancelledRequests.add(targetId);
      }
    }
    return null;
  }

  // Handle other notifications - no response required
  if (
    method === "notifications/initialized" ||
    method.startsWith("notifications/") ||
    method.startsWith("$/")
  ) {
    return null;
  }

  // Check if this request was cancelled
  if (reqId !== null && cancelledRequests && cancelledRequests.has(reqId)) {
    cancelledRequests.delete(reqId);
    return {
      jsonrpc: "2.0",
      id: reqId,
      error: { code: -32800, message: "Request cancelled by client" },
    };
  }

  try {
    // 1. Initialize
    if (method === "initialize") {
      if (
        req.params !== undefined &&
        (typeof req.params !== "object" || req.params === null || Array.isArray(req.params))
      ) {
        return {
          jsonrpc: "2.0",
          id: reqId,
          error: { code: -32602, message: "Invalid params: params must be an object" },
        };
      }
      return {
        jsonrpc: "2.0",
        id: reqId,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "kai-mcp-server",
            version: packageJson.version ?? "0.1.0",
          },
        },
      };
    }

    // 2. List tools
    if (method === "tools/list") {
      if (
        req.params !== undefined &&
        (typeof req.params !== "object" || req.params === null || Array.isArray(req.params))
      ) {
        return {
          jsonrpc: "2.0",
          id: reqId,
          error: { code: -32602, message: "Invalid params: params must be an object" },
        };
      }
      return {
        jsonrpc: "2.0",
        id: reqId,
        result: {
          tools: MCP_TOOLS,
        },
      };
    }

    // 3. Call tool
    if (method === "tools/call") {
      if (
        req.params === undefined ||
        typeof req.params !== "object" ||
        req.params === null ||
        Array.isArray(req.params)
      ) {
        return {
          jsonrpc: "2.0",
          id: reqId,
          error: { code: -32602, message: "Invalid params: params must be an object" },
        };
      }
      const params = req.params as Record<string, unknown>;
      if (typeof params.name !== "string" || !params.name.trim()) {
        return {
          jsonrpc: "2.0",
          id: reqId,
          error: { code: -32602, message: "Invalid params: name is required and must be a string" },
        };
      }
      const toolName = params.name.trim();

      if (
        params.arguments !== undefined &&
        (typeof params.arguments !== "object" ||
          params.arguments === null ||
          Array.isArray(params.arguments))
      ) {
        return {
          jsonrpc: "2.0",
          id: reqId,
          error: { code: -32602, message: "Invalid params: arguments must be an object" },
        };
      }
      const args = (params.arguments || {}) as Record<string, unknown>;

      // Reject unknown tools before touching storage: registration and
      // auto-indexing run a full synchronous scan, which must not be
      // triggerable by a misspelled or malicious tool name.
      const KNOWN_TOOLS = new Set(MCP_TOOLS.map((t) => t.name));
      if (!KNOWN_TOOLS.has(toolName)) {
        return {
          jsonrpc: "2.0",
          id: reqId,
          error: { code: -32601, message: `Unknown tool: ${toolName}` },
        };
      }

      if (args.projectPath !== undefined) {
        if (typeof args.projectPath !== "string") {
          return {
            jsonrpc: "2.0",
            id: reqId,
            error: { code: -32602, message: "Invalid project path: must be a string" },
          };
        }
        if (args.projectPath.includes("\0") || args.projectPath.length > 4096) {
          return {
            jsonrpc: "2.0",
            id: reqId,
            error: {
              code: -32602,
              message: "Invalid project path: contains null bytes or exceeds maximum length",
            },
          };
        }
      }

      const canonicalDefault = resolveCanonicalPath(defaultProjectRoot);
      const projectTarget =
        typeof args.projectPath === "string" ? args.projectPath : defaultProjectRoot;
      const canonicalRoot = resolveCanonicalPath(projectTarget);

      // Security check: Confine tool execution to the authorized server workspace boundary
      if (!isWithinProjectBoundary(canonicalRoot, canonicalDefault)) {
        return {
          jsonrpc: "2.0",
          id: reqId,
          error: {
            code: -32602,
            message: "Project path escapes the authorized server workspace boundary",
          },
        };
      }

      // Verify directory exists and is a directory (not a file).
      let rootStat: fs.Stats | null = null;
      try {
        rootStat = fs.statSync(canonicalRoot);
      } catch {
        rootStat = null;
      }
      if (!rootStat || !rootStat.isDirectory()) {
        return {
          jsonrpc: "2.0",
          id: reqId,
          error: { code: -32602, message: `Project path does not exist or is not a directory` },
        };
      }

      const meta = registerProject(canonicalRoot);
      let index = loadProjectIndex(meta.id);

      // Auto-index if not indexed
      if (!index) {
        index = await indexProject(meta);
      }

      const start = Date.now();

      // Tool dispatch
      if (toolName === "kai_project_info") {
        const languages: Record<string, number> = {};
        for (const file of Object.values(index.files)) {
          languages[file.language] = (languages[file.language] || 0) + 1;
        }

        recordMetric({
          projectId: meta.id,
          operation: "mcp_call",
          latencyMs: Date.now() - start,
          tokensEstimated: 100,
          success: true,
        });

        return {
          jsonrpc: "2.0",
          id: reqId,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    name: meta.name,
                    canonicalPath: meta.canonicalPath,
                    schemaVersion: meta.schemaVersion,
                    lastIndexedAt: meta.lastIndexedAt,
                    status: meta.status,
                    totalFiles: Object.keys(index.files).length,
                    totalSymbols: Object.keys(index.symbolIndex).length,
                    languageBreakdown: languages,
                    rulesCount: index.rules.length,
                    changes: index.changes,
                  },
                  null,
                  2
                ),
              },
            ],
          },
        };
      }

      if (toolName === "kai_search_code") {
        if (typeof args.query !== "string" || !args.query.trim()) {
          return {
            jsonrpc: "2.0",
            id: reqId,
            error: {
              code: -32602,
              message: "query parameter is required and must be a non-empty string",
            },
          };
        }
        if (args.limit !== undefined) {
          if (typeof args.limit !== "number" || !Number.isFinite(args.limit) || args.limit <= 0) {
            return {
              jsonrpc: "2.0",
              id: reqId,
              error: { code: -32602, message: "limit parameter must be a positive number" },
            };
          }
        }
        const query = args.query.trim().slice(0, 2000);
        const limit =
          typeof args.limit === "number" ? Math.min(Math.max(1, Math.floor(args.limit)), 20) : 6;
        const retrieved = retrieveContext(index, query, { fileBudget: limit, tokenBudget: 4000 });

        recordMetric({
          projectId: meta.id,
          operation: "mcp_call",
          latencyMs: Date.now() - start,
          tokensEstimated: retrieved.usedTokens,
          success: true,
        });

        return {
          jsonrpc: "2.0",
          id: reqId,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    query,
                    matchesCount: retrieved.matchedFiles.length,
                    files: retrieved.matchedFiles.map((m) => ({
                      relativePath: m.file.relativePath,
                      score: m.score,
                      startLine: m.startLine,
                      endLine: m.endLine,
                      snippet: (m.snippet || "").slice(0, 8000),
                    })),
                    omissions: retrieved.omissions,
                  },
                  null,
                  2
                ),
              },
            ],
          },
        };
      }

      if (toolName === "kai_find_symbol") {
        if (typeof args.name !== "string" || !args.name.trim()) {
          return {
            jsonrpc: "2.0",
            id: reqId,
            error: {
              code: -32602,
              message: "name parameter is required and must be a non-empty string",
            },
          };
        }
        const name = args.name.trim().slice(0, 256);
        if (name.includes("\0") || /[./\\]/.test(name)) {
          return {
            jsonrpc: "2.0",
            id: reqId,
            error: { code: -32602, message: "invalid symbol name" },
          };
        }
        const found =
          Object.prototype.hasOwnProperty.call(index.symbolIndex, name) &&
          Array.isArray(index.symbolIndex[name])
            ? index.symbolIndex[name]
            : [];

        return {
          jsonrpc: "2.0",
          id: reqId,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    symbolName: name,
                    foundCount: found.length,
                    symbols: found,
                  },
                  null,
                  2
                ),
              },
            ],
          },
        };
      }

      if (toolName === "kai_get_dependencies") {
        if (typeof args.filePath !== "string" || !args.filePath.trim()) {
          return {
            jsonrpc: "2.0",
            id: reqId,
            error: {
              code: -32602,
              message: "filePath parameter is required and must be a non-empty string",
            },
          };
        }
        const rawRel = args.filePath.trim().slice(0, 1024);
        // Normalize Windows separators so `src\a.ts` resolves like `src/a.ts`.
        const targetRel = rawRel.replace(/\\/g, "/");
        const isWindowsAbsolute = /^[a-zA-Z]:\//.test(targetRel) || targetRel.startsWith("//");
        if (
          !targetRel ||
          targetRel.includes("\0") ||
          rawRel.includes("\0") ||
          targetRel.split("/").includes("..") ||
          path.isAbsolute(targetRel) ||
          path.isAbsolute(rawRel) ||
          isWindowsAbsolute
        ) {
          return {
            jsonrpc: "2.0",
            id: reqId,
            error: { code: -32602, message: `Invalid filePath` },
          };
        }

        // Never expose sensitive files (credentials, private keys, environment files)
        if (
          isSensitiveFile(targetRel) ||
          isSensitiveFile(rawRel) ||
          isSensitiveFile(path.basename(targetRel))
        ) {
          return {
            jsonrpc: "2.0",
            id: reqId,
            error: {
              code: -32602,
              message: `Access denied: sensitive or excluded file: ${targetRel}`,
            },
          };
        }

        // Confine file path to the authorized canonical project boundary
        const fullFilePath = path.join(canonicalRoot, targetRel);
        let canonicalFile: string;
        try {
          canonicalFile = resolveCanonicalPath(fullFilePath);
        } catch {
          return {
            jsonrpc: "2.0",
            id: reqId,
            error: { code: -32602, message: `File not found in index: ${targetRel}` },
          };
        }
        if (!isWithinProjectBoundary(canonicalFile, canonicalRoot)) {
          return {
            jsonrpc: "2.0",
            id: reqId,
            error: { code: -32602, message: `File path escapes project boundary: ${targetRel}` },
          };
        }

        const file =
          (Object.prototype.hasOwnProperty.call(index.files, targetRel)
            ? index.files[targetRel]
            : undefined) ??
          (Object.prototype.hasOwnProperty.call(index.files, rawRel)
            ? index.files[rawRel]
            : undefined);
        if (!file) {
          return {
            jsonrpc: "2.0",
            id: reqId,
            error: { code: -32602, message: `File not found in index: ${targetRel}` },
          };
        }

        return {
          jsonrpc: "2.0",
          id: reqId,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    filePath: targetRel,
                    dependenciesCount: file.dependencies.length,
                    dependencies: file.dependencies,
                  },
                  null,
                  2
                ),
              },
            ],
          },
        };
      }

      if (toolName === "kai_get_context") {
        if (typeof args.task !== "string" || !args.task.trim()) {
          return {
            jsonrpc: "2.0",
            id: reqId,
            error: {
              code: -32602,
              message: "task parameter is required and must be a non-empty string",
            },
          };
        }
        const task = args.task.trim().slice(0, 4000);
        const rawBudget = typeof args.tokenBudget === "number" ? args.tokenBudget : 4000;
        const tokenBudget = Math.min(
          Math.max(Number.isFinite(rawBudget) ? Math.floor(rawBudget) : 4000, 200),
          20000
        );
        const VALID_CATEGORIES = new Set([
          "explain",
          "implement",
          "debug",
          "refactor",
          "test",
          "review",
          "architecture",
          "documentation",
          "unknown",
        ]);
        const categoryOverride = (
          typeof args.categoryOverride === "string" && VALID_CATEGORIES.has(args.categoryOverride)
            ? args.categoryOverride
            : undefined
        ) as TaskCategory | undefined;

        const { renderedPrompt, contextPackage } = assembleContext(index, {
          task,
          tokenBudget,
          categoryOverride,
        });

        recordMetric({
          projectId: meta.id,
          operation: "mcp_call",
          latencyMs: Date.now() - start,
          tokensEstimated: contextPackage.tokenMetrics.estimatedTokens,
          success: true,
        });

        return {
          jsonrpc: "2.0",
          id: reqId,
          result: {
            content: [
              {
                type: "text",
                text: renderedPrompt,
              },
            ],
          },
        };
      }

      if (toolName === "kai_refresh_index") {
        if (args.forceRebuild !== undefined && typeof args.forceRebuild !== "boolean") {
          return {
            jsonrpc: "2.0",
            id: reqId,
            error: { code: -32602, message: "forceRebuild must be a boolean" },
          };
        }
        const forceRebuild = Boolean(args.forceRebuild);
        const refreshedIndex = await indexProject(meta, { forceRebuild });

        return {
          jsonrpc: "2.0",
          id: reqId,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    refreshed: true,
                    totalFiles: Object.keys(refreshedIndex.files).length,
                    totalSymbols: Object.keys(refreshedIndex.symbolIndex).length,
                    changes: refreshedIndex.changes,
                    timestamp: refreshedIndex.generatedAt,
                  },
                  null,
                  2
                ),
              },
            ],
          },
        };
      }

      if (toolName === "kai_strip_coauthors") {
        if (args.last !== undefined) {
          if (typeof args.last !== "number" || !Number.isFinite(args.last) || args.last < 1) {
            return {
              jsonrpc: "2.0",
              id: reqId,
              error: { code: -32602, message: "last parameter must be a positive number" },
            };
          }
        }
        if (args.match !== undefined && typeof args.match !== "string") {
          return {
            jsonrpc: "2.0",
            id: reqId,
            error: { code: -32602, message: "match parameter must be a string" },
          };
        }
        for (const flag of ["dryRun", "force"] as const) {
          if (args[flag] !== undefined && typeof args[flag] !== "boolean") {
            return {
              jsonrpc: "2.0",
              id: reqId,
              error: { code: -32602, message: `${flag} must be a boolean` },
            };
          }
        }
        const last =
          typeof args.last === "number" ? Math.min(Math.max(1, Math.floor(args.last)), 50) : 1;
        const match = typeof args.match === "string" ? args.match.trim().slice(0, 256) : undefined;
        try {
          const { stripCoAuthorsInRepo } = await import("./coauthors");
          const result = stripCoAuthorsInRepo(canonicalRoot, {
            last,
            match,
            dryRun: Boolean(args.dryRun),
            force: Boolean(args.force),
          });
          recordMetric({
            projectId: meta.id,
            operation: "mcp_call",
            latencyMs: Date.now() - start,
            tokensEstimated: 0,
            success: true,
          });
          return {
            jsonrpc: "2.0",
            id: reqId,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result, null, 2),
                },
              ],
            },
          };
        } catch (err: unknown) {
          // Operational refusals (dirty tree, pushed history, merges) are
          // expected outcomes with actionable messages, not server faults.
          return {
            jsonrpc: "2.0",
            id: reqId,
            error: { code: -32602, message: err instanceof Error ? err.message : String(err) },
          };
        }
      }

      if (toolName === "kai_get_lsp_status") {
        const detected = detectInstalledLspServers();
        const available = detected.some((d) => d.isAvailable);
        return {
          jsonrpc: "2.0",
          id: reqId,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    lspBridgeAvailable: available,
                    degradedMode: !available,
                    degradedReason: available
                      ? undefined
                      : "No local language servers detected. Operating in degraded syntax-only mode.",
                    servers: detected,
                  },
                  null,
                  2
                ),
              },
            ],
          },
        };
      }

      return {
        jsonrpc: "2.0",
        id: reqId,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      };
    }

    return {
      jsonrpc: "2.0",
      id: reqId,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  } catch (err: unknown) {
    return {
      jsonrpc: "2.0",
      id: reqId,
      error: { code: -32603, message: `Internal server error: ${String(err)}` },
    };
  }
}

export const MAX_MCP_LINE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Stream transform that rejects oversized lines at the byte stream level
 * BEFORE unbounded memory accumulation can occur inside readline or Node buffers.
 */
export class BoundedLineTransform extends Transform {
  private maxBytes: number;
  private currentBytes: number = 0;
  private isDiscarding: boolean = false;
  private lineChunks: Buffer[] = [];
  private onOversized?: () => void;

  constructor(maxBytes: number = MAX_MCP_LINE_BYTES, onOversized?: () => void) {
    super();
    this.maxBytes = maxBytes;
    this.onOversized = onOversized;
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0x0a) {
        // newline \n encountered
        const piece = chunk.subarray(start, i + 1);
        start = i + 1;

        if (this.isDiscarding) {
          this.isDiscarding = false;
          this.currentBytes = 0;
          this.lineChunks = [];
        } else {
          this.currentBytes += piece.length;
          if (this.currentBytes > this.maxBytes) {
            this.isDiscarding = false;
            this.currentBytes = 0;
            this.lineChunks = [];
            if (this.onOversized) {
              this.onOversized();
            }
          } else {
            if (this.lineChunks.length === 0) {
              this.push(piece);
            } else {
              this.lineChunks.push(piece);
              this.push(Buffer.concat(this.lineChunks));
              this.lineChunks = [];
            }
            this.currentBytes = 0;
          }
        }
      }
    }

    if (start < chunk.length) {
      const remaining = chunk.subarray(start);
      if (this.isDiscarding) {
        // Continue discarding until next newline
      } else {
        this.currentBytes += remaining.length;
        if (this.currentBytes > this.maxBytes) {
          this.isDiscarding = true;
          this.lineChunks = [];
          if (this.onOversized) {
            this.onOversized();
          }
        } else {
          this.lineChunks.push(remaining);
        }
      }
    }

    callback();
  }

  _flush(callback: () => void): void {
    if (!this.isDiscarding && this.lineChunks.length > 0 && this.currentBytes <= this.maxBytes) {
      this.push(Buffer.concat(this.lineChunks));
    }
    this.lineChunks = [];
    callback();
  }
}

/**
 * Safely write data to a writable stream without throwing on closed/broken streams.
 */
export function safeWrite(stream: NodeJS.WritableStream, data: string): boolean {
  try {
    const s = stream as unknown as {
      writable?: boolean;
      destroyed?: boolean;
      write: (d: string) => boolean;
    };
    if (s.writable === false || s.destroyed === true) return false;
    return stream.write(data);
  } catch {
    return false;
  }
}

/**
 * Run the stdio JSON-RPC server loop
 */
export async function startMcpServer(
  projectRoot: string = process.cwd(),
  inputStream: NodeJS.ReadableStream = process.stdin,
  outputStream: NodeJS.WritableStream = process.stdout
): Promise<void> {
  let canonicalRoot: string;
  try {
    canonicalRoot = resolveCanonicalPath(projectRoot);
    const rootStat = fs.statSync(canonicalRoot);
    if (!rootStat.isDirectory()) {
      process.stderr.write(`[kai-mcp] Error: project root "${projectRoot}" is not a directory.\n`);
      return;
    }
  } catch (err: unknown) {
    process.stderr.write(
      `[kai-mcp] Error: cannot access project root "${projectRoot}": ${err instanceof Error ? err.message : String(err)}\n`
    );
    return;
  }

  // Protocol on stdout ONLY. Diagnostic messages on stderr.
  process.stderr.write(`[kai-mcp] Starting MCP stdio server for root: ${canonicalRoot}\n`);

  let isTerminated = false;
  const sessionCancelledRequests = new Set<string | number>();

  const onStreamError = (err: NodeJS.ErrnoException) => {
    if (err && (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED")) {
      isTerminated = true;
      return;
    }
    process.stderr.write(`[kai-mcp] Stream diagnostic: ${err?.message || String(err)}\n`);
  };

  outputStream.on("error", onStreamError);
  inputStream.on("error", onStreamError);

  const boundedStream = new BoundedLineTransform(MAX_MCP_LINE_BYTES, () => {
    const errResponse: McpResponse = {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Request line exceeds maximum allowed size (10 MB)" },
    };
    safeWrite(outputStream, JSON.stringify(errResponse) + "\n");
  });
  boundedStream.on("error", onStreamError);

  (inputStream as NodeJS.ReadStream).pipe(boundedStream);

  const rl = readline.createInterface({
    input: boundedStream,
    terminal: false,
  });

  try {
    for await (const line of rl) {
      if (isTerminated) {
        break;
      }

      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: McpRequest;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        const errResponse: McpResponse = {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        };
        safeWrite(outputStream, JSON.stringify(errResponse) + "\n");
        continue;
      }

      const response = await handleMcpMessage(parsed, canonicalRoot, sessionCancelledRequests);
      if (response && !isTerminated) {
        const wrote = safeWrite(outputStream, JSON.stringify(response) + "\n");
        if (!wrote && (outputStream as unknown as { writable?: boolean })?.writable === false) {
          break;
        }
      }
    }
  } catch (err: unknown) {
    const errCode = (err as NodeJS.ErrnoException)?.code;
    if (errCode !== "EPIPE" && errCode !== "ERR_STREAM_DESTROYED") {
      process.stderr.write(
        `[kai-mcp] Server loop diagnostic: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  } finally {
    rl.close();
    process.stderr.write("[kai-mcp] Server closed.\n");
  }
}
