import readline from "readline";
import fs from "fs";
import path from "path";
import { registerProject, loadProjectIndex, resolveCanonicalPath } from "./registry";
import { indexProject } from "./indexer";
import { assembleContext } from "./contextAssembler";
import { retrieveContext } from "./retrieval";
import { recordMetric } from "./telemetry";
import { detectInstalledLspServers } from "./lspBridge";
import type { TaskCategory } from "./types";

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
  message: McpRequest,
  defaultProjectRoot: string = process.cwd()
): Promise<McpResponse | null> {
  const reqId = message.id !== undefined ? message.id : null;
  const method = message.method;

  try {
    // 1. Initialize
    if (method === "initialize") {
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
            version: "0.1.0",
          },
        },
      };
    }

    // 2. Notifications (e.g. notifications/initialized) - no response required
    if (method === "notifications/initialized" || method.startsWith("notifications/")) {
      return null;
    }

    // 3. List tools
    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id: reqId,
        result: {
          tools: MCP_TOOLS,
        },
      };
    }

    // 4. Call tool
    if (method === "tools/call") {
      const params = (message.params || {}) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      const toolName = params.name;
      const args = params.arguments || {};

      // Reject unknown tools before touching storage: registration and
      // auto-indexing run a full synchronous scan, which must not be
      // triggerable by a misspelled or malicious tool name.
      const KNOWN_TOOLS = new Set(MCP_TOOLS.map((t) => t.name));
      if (toolName !== undefined && !KNOWN_TOOLS.has(toolName)) {
        return {
          jsonrpc: "2.0",
          id: reqId,
          error: { code: -32601, message: `Unknown tool: ${toolName}` },
        };
      }

      const canonicalDefault = resolveCanonicalPath(defaultProjectRoot);
      const projectTarget =
        typeof args.projectPath === "string" ? args.projectPath : defaultProjectRoot;
      const canonicalRoot = resolveCanonicalPath(projectTarget);

      // Security check: Confine tool execution to the authorized server workspace boundary
      if (
        canonicalRoot !== canonicalDefault &&
        !canonicalRoot.startsWith(canonicalDefault + path.sep)
      ) {
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
        const query = String(args.query || "").slice(0, 2000);
        if (!query.trim()) {
          return {
            jsonrpc: "2.0",
            id: reqId,
            error: { code: -32602, message: "query parameter is required" },
          };
        }
        const limit = typeof args.limit === "number" ? Math.min(Math.max(1, args.limit), 20) : 6;
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
        const name = String(args.name || "")
          .trim()
          .slice(0, 256);
        if (!name) {
          return {
            jsonrpc: "2.0",
            id: reqId,
            error: { code: -32602, message: "name parameter is required" },
          };
        }
        if (/[./\\]/.test(name)) {
          return {
            jsonrpc: "2.0",
            id: reqId,
            error: { code: -32602, message: "invalid symbol name" },
          };
        }
        const found = index.symbolIndex[name] || [];

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
        const rawRel = String(args.filePath || "")
          .trim()
          .slice(0, 1024);
        // Normalize Windows separators so `src\a.ts` resolves like `src/a.ts`.
        const targetRel = rawRel.replace(/\\/g, "/");
        const isWindowsAbsolute = /^[a-zA-Z]:\//.test(targetRel) || targetRel.startsWith("//");
        if (
          !targetRel ||
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
        const file = index.files[targetRel] ?? index.files[rawRel];
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
        const task = String(args.task || "")
          .trim()
          .slice(0, 4000);
        if (!task) {
          return {
            jsonrpc: "2.0",
            id: reqId,
            error: { code: -32602, message: "task parameter is required" },
          };
        }
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

      if (toolName === "kai_get_lsp_status") {
        const detected = detectInstalledLspServers();
        return {
          jsonrpc: "2.0",
          id: reqId,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    lspBridgeAvailable: detected.some((d) => d.isAvailable),
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

/**
 * Run the stdio JSON-RPC server loop
 */
export async function startMcpServer(projectRoot: string = process.cwd()): Promise<void> {
  // Protocol on stdout ONLY. Diagnostic messages on stderr.
  process.stderr.write(`[kai-mcp] Starting MCP stdio server for root: ${projectRoot}\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  for await (const line of rl) {
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
      process.stdout.write(JSON.stringify(errResponse) + "\n");
      continue;
    }

    const response = await handleMcpMessage(parsed, projectRoot);
    if (response) {
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  }

  process.stderr.write("[kai-mcp] Server closed.\n");
}
