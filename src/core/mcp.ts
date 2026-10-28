import readline from "readline";
import { Transform } from "stream";
import fs from "fs";
import {
  registerProject,
  loadProjectIndexShared,
  resolveCanonicalPath,
  isWithinProjectBoundary,
} from "./registry";
import { indexProject } from "./indexer";
import { recordMetric } from "./telemetry";
import { getGraphFreshness, ensureFreshIndex } from "./codeModeWorkflow";
import { startGraphWatcher } from "./graphWatcher";
import {
  MAX_ID_BYTES,
  clipForMessage,
  finalizeResponse,
  getMaxResponseBytes,
  shapeTextResult,
  shapeToolResult,
  utf8Bytes,
  wrapperBytes,
} from "./mcpResponse";
import {
  estimateTextTokens,
  toolFindSymbol,
  toolGetContext,
  toolGetDependencies,
  toolLspStatus,
  toolPlanTask,
  toolProjectInfo,
  toolReadRange,
  toolRefreshIndex,
  toolSearchCode,
  toolSyncGraph,
  type ToolContext,
  type ToolOutcome,
} from "./mcpTools";
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

const PROJECT_PATH_PROP = { type: "string", description: "Optional project root." };
const PAGE_PROPS = {
  limit: { type: "number", description: "Page size." },
  offset: { type: "number", description: "Items to skip (use nextOffset)." },
};
const CATEGORY_PROP = {
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
  description: "Optional task category override.",
};

/**
 * Every tool result is bounded (see mcpResponse.ts): collections paginate with
 * limit/offset and the whole response stays under the server's byte ceiling
 * (KAI_MCP_MAX_RESPONSE_BYTES, default 64 KiB). Token figures are heuristic
 * estimates, never model-reported usage. Descriptions stay short on purpose:
 * agents carry these definitions in context on every turn.
 */
export const MCP_TOOLS = [
  {
    name: "kai_project_info",
    description: "Project summary: languages, file/symbol counts, freshness, scan completeness.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: PROJECT_PATH_PROP,
        includeChanges: { type: "boolean", description: "List last build's changed files." },
        ...PAGE_PROPS,
      },
    },
  },
  {
    name: "kai_search_code",
    description:
      "Ranked file/symbol search returning metadata only (default 6, max 20 per page). Read code with kai_read_range.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keywords." },
        includeSource: { type: "boolean", description: "Also return snippets (default false)." },
        ...PAGE_PROPS,
        projectPath: PROJECT_PATH_PROP,
      },
      required: ["query"],
    },
  },
  {
    name: "kai_read_range",
    description:
      "Read a bounded source range (max 400 lines) by symbol or lines. expectedHash detects edits since search.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Project-relative file (optional if symbol is unique).",
        },
        symbol: { type: "string", description: "Name or Class.method." },
        startLine: { type: "number" },
        endLine: { type: "number" },
        contextLines: { type: "number", description: "Extra lines around (0-20)." },
        maxLines: { type: "number", description: "Default 200." },
        expectedHash: { type: "string", description: "contentHash from an earlier result." },
        projectPath: PROJECT_PATH_PROP,
      },
    },
  },
  {
    name: "kai_find_symbol",
    description: "Find symbol definitions with line ranges and signatures (default 25, max 100).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Symbol name." },
        ...PAGE_PROPS,
        projectPath: PROJECT_PATH_PROP,
      },
      required: ["name"],
    },
  },
  {
    name: "kai_get_dependencies",
    description: "A file's imports with resolution status (default 50, max 200). Imports only.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Project-relative file." },
        includeDependents: {
          type: "boolean",
          description: "List files importing it (paged by limit/offset; see dependentsHasMore).",
        },
        ...PAGE_PROPS,
        projectPath: PROJECT_PATH_PROP,
      },
      required: ["filePath"],
    },
  },
  {
    name: "kai_get_context",
    description:
      "Task context package (ranked sources, rules, skills) within a heuristic token budget and the response size limit.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task or question." },
        categoryOverride: CATEGORY_PROP,
        tokenBudget: { type: "number", description: "Default depends on task type; max 20000." },
        projectPath: PROJECT_PATH_PROP,
      },
      required: ["task"],
    },
  },
  {
    name: "kai_refresh_index",
    description: "Safe, bounded incremental re-index.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: PROJECT_PATH_PROP,
        forceRebuild: { type: "boolean", description: "Full rebuild." },
        includeChanges: { type: "boolean", description: "List changed files." },
        ...PAGE_PROPS,
      },
    },
  },
  {
    name: "kai_get_lsp_status",
    description: "Installed local language servers.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: PROJECT_PATH_PROP,
      },
    },
  },
  {
    name: "kai_plan_task",
    description:
      "Code Mode only: classify a task with graph context; returns at most two prompt options, none for simple tasks.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task description." },
        mode: { type: "string", description: "Options only when 'code'." },
        categoryOverride: CATEGORY_PROP,
        projectPath: PROJECT_PATH_PROP,
        selectedFiles: {
          type: "array",
          items: { type: "string" },
          description: "User-selected files (project-relative), planned as primary targets.",
        },
        selectedFile: { type: "string", description: "Single-file alias for selectedFiles." },
      },
      required: ["task"],
    },
  },
  {
    name: "kai_sync_graph",
    description:
      "Code Mode only: validated graph sync after code changes; keeps the last-known-good graph on failure.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", description: "Syncs only when 'code'." },
        changedFiles: {
          type: "array",
          items: { type: "string" },
          description: "Caller-reported changed paths (unverified; empty skips rebuild).",
        },
        forceFull: { type: "boolean", description: "Force a full validated rebuild." },
        uncertain: { type: "boolean", description: "Impact uncertain; forces full rebuild." },
        codeValidationRan: { type: "boolean", description: "Whether checks ran." },
        codeValidationPassed: {
          type: "boolean",
          description: "Whether checks passed; report only what ran (default false).",
        },
        codeValidationDetail: { type: "string", description: "Which checks ran and the outcome." },
        projectPath: PROJECT_PATH_PROP,
      },
    },
  },
];

/** Tools that read the graph and therefore pass the automatic freshness gate first. */
const GATED_TOOLS = new Set([
  "kai_search_code",
  "kai_find_symbol",
  "kai_get_dependencies",
  "kai_get_context",
  "kai_read_range",
]);

/**
 * Handle incoming MCP JSON-RPC messages and return the JSON-RPC response.
 * Every response, including errors, leaves through the size guard in
 * `finalizeResponse`, so no code path can exceed the response ceiling.
 */
export async function handleMcpMessage(
  message: unknown,
  defaultProjectRoot: string = process.cwd(),
  cancelledRequests?: Set<string | number>
): Promise<McpResponse | null> {
  const response = await dispatchMcpMessage(message, defaultProjectRoot, cancelledRequests);
  return response ? finalizeResponse(response) : null;
}

async function dispatchMcpMessage(
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

  if (typeof req.id === "string" && utf8Bytes(req.id) > MAX_ID_BYTES) {
    // The id is echoed in every response; an oversized one would defeat the size ceiling.
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: `Invalid Request: id exceeds ${MAX_ID_BYTES} bytes` },
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
            name: "kai-terminal-mcp-server",
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
          error: { code: -32601, message: `Unknown tool: ${clipForMessage(toolName, 80)}` },
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
      // Read-only shared load: a frozen, cached parse while index.json's stat
      // signature is unchanged (see registry.loadProjectIndexShared).
      const loaded = loadProjectIndexShared(meta.id);
      let index = loaded.index;
      const indexCache = loaded.cache;

      // Auto-index if not indexed
      if (!index) {
        index = await indexProject(meta);
      }

      // Automatic synchronization gate for graph-dependent reads. External
      // agents edit files directly and may never call kai_sync_graph, so
      // before relying on the graph, reconcile on-disk drift with a single
      // bounded incremental refresh. kai_plan_task runs its own gate inside
      // planCodeTask; kai_sync_graph and kai_refresh_index manage indexing
      // themselves. Never throws: falls back to the stale index truthfully.
      let gate: ToolContext["gate"] = { freshness: "unknown", refreshOutcome: "not-required" };
      let refreshMs: number | undefined;
      if (GATED_TOOLS.has(toolName)) {
        const gateStart = Date.now();
        try {
          const ensured = await ensureFreshIndex(meta, index);
          if (ensured.index) index = ensured.index;
          gate = {
            freshness: ensured.freshnessAfter,
            refreshOutcome: ensured.refreshOutcome,
            warning: ensured.warning,
            knownStaleness: ensured.knownStaleness,
          };
        } catch {
          gate = {
            freshness: getGraphFreshness(index),
            refreshOutcome: "refresh-failed",
            warning: "Automatic graph refresh failed; results use the last-known index.",
          };
        }
        refreshMs = Date.now() - gateStart;
      }

      const start = Date.now();
      const maxBytes = getMaxResponseBytes();
      const ctx: ToolContext = {
        meta,
        index,
        canonicalRoot,
        gate,
        maxBytes,
        wrapperBytes: wrapperBytes(reqId),
      };

      let outcome: ToolOutcome;
      switch (toolName) {
        case "kai_project_info":
          outcome = toolProjectInfo(ctx, args);
          break;
        case "kai_search_code":
          outcome = toolSearchCode(ctx, args);
          break;
        case "kai_read_range":
          outcome = toolReadRange(ctx, args);
          break;
        case "kai_find_symbol":
          outcome = toolFindSymbol(ctx, args);
          break;
        case "kai_get_dependencies":
          outcome = toolGetDependencies(ctx, args);
          break;
        case "kai_get_context":
          outcome = toolGetContext(ctx, args);
          break;
        case "kai_refresh_index":
          outcome = await toolRefreshIndex(ctx, args);
          break;
        case "kai_get_lsp_status":
          outcome = toolLspStatus();
          break;
        case "kai_plan_task":
          outcome = await toolPlanTask(ctx, args);
          break;
        case "kai_sync_graph":
          outcome = await toolSyncGraph(ctx, args);
          break;
        default:
          return {
            jsonrpc: "2.0",
            id: reqId,
            error: { code: -32601, message: `Unknown tool: ${clipForMessage(toolName, 80)}` },
          };
      }

      if (outcome.kind === "error") {
        return {
          jsonrpc: "2.0",
          id: reqId,
          error: { code: outcome.code, message: clipForMessage(outcome.message, 400) },
        };
      }

      const shaped =
        outcome.kind === "json"
          ? shapeToolResult(reqId, toolName, outcome.payload, {
              maxBytes,
              shrink: outcome.shrink,
            })
          : shapeTextResult(reqId, toolName, outcome.text, {
              maxBytes,
              preserve: outcome.preserve,
            });

      // Size of what was actually returned, by the heuristic counter (never
      // model-reported usage); metadata only, no source or prompt text.
      const responseText = (
        shaped.response.result as { content?: Array<{ text?: string }> } | undefined
      )?.content?.[0]?.text;
      recordMetric({
        projectId: meta.id,
        operation: "mcp_call",
        tool: toolName,
        latencyMs: Date.now() - start,
        ...(typeof responseText === "string"
          ? { tokensEstimated: estimateTextTokens(responseText), tokensAreEstimate: true }
          : {}),
        responseBytes: shaped.bytes,
        ...(outcome.metrics?.resultCount !== undefined
          ? { resultCount: outcome.metrics.resultCount }
          : {}),
        ...(outcome.metrics?.sourceRanges !== undefined
          ? { sourceRanges: outcome.metrics.sourceRanges }
          : {}),
        ...(GATED_TOOLS.has(toolName) ? { refreshOutcome: gate.refreshOutcome, refreshMs } : {}),
        indexCache,
        ...(outcome.metrics?.retrievalMs !== undefined
          ? { retrievalMs: outcome.metrics.retrievalMs }
          : {}),
        ...(outcome.metrics?.graphSteps !== undefined
          ? { graphSteps: outcome.metrics.graphSteps }
          : {}),
        truncated: shaped.truncated,
        ...(outcome.metrics?.hasMore !== undefined ? { hasMore: outcome.metrics.hasMore } : {}),
        success: true,
      });
      return shaped.response;
    }

    return {
      jsonrpc: "2.0",
      id: reqId,
      error: { code: -32601, message: `Method not found: ${clipForMessage(method, 80)}` },
    };
  } catch (err: unknown) {
    return {
      jsonrpc: "2.0",
      id: reqId,
      error: { code: -32603, message: `Internal server error: ${clipForMessage(err, 300)}` },
    };
  }
}

const MAX_MCP_LINE_BYTES = 10 * 1024 * 1024; // 10 MB

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
function safeWrite(stream: NodeJS.WritableStream, data: string): boolean {
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
  outputStream: NodeJS.WritableStream = process.stdout,
  options: { watch?: boolean } = {}
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

  // Opt-in (default off): keep the graph fresh for pure-MCP clients that edit
  // files without calling a graph read or kai_sync_graph. See graphWatcher.ts.
  const graphWatcher = options.watch ? startGraphWatcher(canonicalRoot) : null;
  if (graphWatcher) process.stderr.write("[kai-mcp] Graph watcher enabled (--watch).\n");

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
    graphWatcher?.close();
    rl.close();
    process.stderr.write("[kai-mcp] Server closed.\n");
  }
}
