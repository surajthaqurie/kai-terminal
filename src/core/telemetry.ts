import fs from "fs";
import path from "path";
import { getKaiHomeDir } from "./registry";

export interface LocalMetricsRecord {
  timestamp: string;
  projectId: string;
  operation: "index" | "retrieve" | "mcp_call" | "rebuild";
  latencyMs: number;
  tokensEstimated: number;
  filesRetrieved?: number;
  budgetUtilizationPct?: number;
  success: boolean;
  errorCode?: string;
}

export interface TelemetrySummary {
  totalOperations: number;
  avgLatencyMs: number;
  totalTokensEstimated: number;
  errorRatePct: number;
  operationsBreakdown: Record<string, number>;
}

export function getMetricsLogPath(): string {
  return path.join(getKaiHomeDir(), "metrics.jsonl");
}

/**
 * Record a privacy-safe metric event.
 * Never logs user prompts, file contents, or secret tokens.
 */
export function recordMetric(event: Omit<LocalMetricsRecord, "timestamp">): void {
  try {
    const record: LocalMetricsRecord = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    const logPath = getMetricsLogPath();
    const line = JSON.stringify(record) + "\n";
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
      errorRatePct: 0,
      operationsBreakdown: {},
    };
  }

  try {
    const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    let totalLatency = 0;
    let totalTokens = 0;
    let errors = 0;
    let parsed = 0;
    const breakdown: Record<string, number> = {};

    for (const line of lines) {
      try {
        const item: LocalMetricsRecord = JSON.parse(line);
        parsed++;
        totalLatency += item.latencyMs || 0;
        totalTokens += item.tokensEstimated || 0;
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
      errorRatePct: count > 0 ? Math.round((errors / count) * 100) : 0,
      operationsBreakdown: breakdown,
    };
  } catch {
    return {
      totalOperations: 0,
      avgLatencyMs: 0,
      totalTokensEstimated: 0,
      errorRatePct: 0,
      operationsBreakdown: {},
    };
  }
}

export function clearMetricsLog(): void {
  const logPath = getMetricsLogPath();
  if (fs.existsSync(logPath)) {
    try {
      fs.unlinkSync(logPath);
    } catch {
      // Ignore
    }
  }
}
