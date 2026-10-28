import fs from "fs";
import path from "path";
import { getKaiHomeDir, ensureKaiDirectories } from "./registry";

/**
 * Local, privacy-safe metric event. Never carries prompts, source text, file
 * contents or secrets: only names, counts, sizes and timings.
 *
 * Kai does not call a model, so nothing here is model-reported usage.
 * `tokensEstimated` is the size of the MCP *response* by Kai's heuristic
 * counter (see `tokensAreEstimate`); it is omitted when no measured text
 * exists, never filled with a placeholder.
 */
export interface LocalMetricsRecord {
  timestamp: string;
  projectId: string;
  operation: "index" | "retrieve" | "mcp_call" | "rebuild";
  latencyMs: number;
  /** Heuristic token estimate of the produced text. Absent when not measured. */
  tokensEstimated?: number;
  /** True when `tokensEstimated` comes from the character heuristic rather than a tokenizer. */
  tokensAreEstimate?: boolean;
  filesRetrieved?: number;
  budgetUtilizationPct?: number;
  success: boolean;
  errorCode?: string;
  /** MCP tool name. */
  tool?: string;
  /** Items in the primary result collection. */
  resultCount?: number;
  /** UTF-8 bytes of the full JSON-RPC response line. */
  responseBytes?: number;
  /** Source ranges (snippets / read ranges) included in the response. */
  sourceRanges?: number;
  /** Outcome of the automatic freshness gate for this call. */
  refreshOutcome?: "not-required" | "refreshed" | "refresh-failed";
  /** Time spent in the freshness gate (drift check plus any refresh). */
  refreshMs?: number;
  /** Whether the parsed index came from the in-process cache. */
  indexCache?: "hit" | "miss";
  /** Time spent in retrieval / ranking itself. */
  retrievalMs?: number;
  /** Import-graph expansion steps taken (nodes visited). */
  graphSteps?: number;
  /** The response was shortened by the output ceiling or a budget. */
  truncated?: boolean;
  /** More results exist beyond this page. */
  hasMore?: boolean;
}

export interface TelemetrySummary {
  totalOperations: number;
  avgLatencyMs: number;
  /** Sum of the estimates that were actually recorded (heuristic; see tokensAreEstimate). */
  totalTokensEstimated: number;
  /** How many records carried an estimate (the sum covers only these). */
  recordsWithTokenEstimate: number;
  errorRatePct: number;
  operationsBreakdown: Record<string, number>;
}

function getMetricsLogPath(): string {
  return path.join(getKaiHomeDir(), "metrics.jsonl");
}

// Every MCP call appends a line; without a cap the log grows forever and
// `getTelemetrySummary` would slurp it all into memory. One rotated
// generation (`metrics.jsonl.1`) keeps recent history bounded to ~2x this.
const MAX_METRICS_LOG_BYTES = 5 * 1024 * 1024;

function rotateMetricsLogIfLarge(logPath: string): void {
  try {
    if (fs.statSync(logPath).size > MAX_METRICS_LOG_BYTES) {
      fs.renameSync(logPath, `${logPath}.1`);
    }
  } catch {
    // Missing file (first write) or rename race: appending still works.
  }
}

/**
 * Record a privacy-safe metric event.
 * Never logs user prompts, file contents, or secret tokens.
 */
export function recordMetric(event: Omit<LocalMetricsRecord, "timestamp">): void {
  try {
    ensureKaiDirectories();
    const record: LocalMetricsRecord = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    const logPath = getMetricsLogPath();
    const line = JSON.stringify(record) + "\n";
    rotateMetricsLogIfLarge(logPath);
    fs.appendFileSync(logPath, line, { mode: 0o600, encoding: "utf-8" });
  } catch {
    // Metric recording is non-critical; never crash operations
  }
}

export function getTelemetrySummary(): TelemetrySummary {
  const logPath = getMetricsLogPath();
  if (!fs.existsSync(logPath)) {
    return {
      totalOperations: 0,
      avgLatencyMs: 0,
      totalTokensEstimated: 0,
      recordsWithTokenEstimate: 0,
      errorRatePct: 0,
      operationsBreakdown: {},
    };
  }

  try {
    const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    let totalLatency = 0;
    let totalTokens = 0;
    let withEstimate = 0;
    let errors = 0;
    let parsed = 0;
    const breakdown: Record<string, number> = {};

    for (const line of lines) {
      try {
        const item: LocalMetricsRecord = JSON.parse(line);
        parsed++;
        totalLatency += item.latencyMs || 0;
        if (typeof item.tokensEstimated === "number") {
          totalTokens += item.tokensEstimated;
          withEstimate++;
        }
        if (!item.success) errors++;
        breakdown[item.operation] = (breakdown[item.operation] || 0) + 1;
      } catch {
        // Skip malformed line
      }
    }

    const count = parsed;
    return {
      totalOperations: count,
      avgLatencyMs: count > 0 ? Math.round(totalLatency / count) : 0,
      totalTokensEstimated: totalTokens,
      recordsWithTokenEstimate: withEstimate,
      errorRatePct: count > 0 ? Math.round((errors / count) * 100) : 0,
      operationsBreakdown: breakdown,
    };
  } catch {
    return {
      totalOperations: 0,
      avgLatencyMs: 0,
      totalTokensEstimated: 0,
      recordsWithTokenEstimate: 0,
      errorRatePct: 0,
      operationsBreakdown: {},
    };
  }
}

export function clearMetricsLog(): void {
  const logPath = getMetricsLogPath();
  for (const p of [logPath, `${logPath}.1`]) {
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        // Ignore
      }
    }
  }
}
