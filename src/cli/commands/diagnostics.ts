import { getTelemetrySummary, clearMetricsLog } from "../../core/telemetry";
import { detectInstalledLspServers } from "../../core/lspBridge";

export async function runMetrics(args: string[]): Promise<number> {
  if (args[1] === "clear") {
    clearMetricsLog();
    console.log(`[kai] Local metrics log cleared.`);
    return 0;
  }

  const summary = getTelemetrySummary();
  console.log(`[kai] Local Privacy-Safe Telemetry Summary:`);
  console.log(`  Total Operations:      ${summary.totalOperations}`);
  console.log(`  Average Latency:       ${summary.avgLatencyMs} ms`);
  console.log(`  Total Est. Tokens:     ${summary.totalTokensEstimated}`);
  console.log(`  Error Rate:            ${summary.errorRatePct}%`);
  console.log(`  Operation Breakdown:   ${JSON.stringify(summary.operationsBreakdown, null, 2)}`);
  return 0;
}

export async function runLsp(): Promise<number> {
  const detected = detectInstalledLspServers();
  console.log(`[kai] Language Server Protocol (LSP) Bridge Status:`);
  for (const server of detected) {
    const statusIcon = server.isAvailable ? "✓" : "✗";
    const statusText = server.isAvailable
      ? `Available (${server.version || "installed"})`
      : "Not Found";
    console.log(
      `  ${statusIcon} ${server.language.padEnd(12)} ${server.command.padEnd(28)} ${statusText}`
    );
    if (!server.isAvailable && server.installHint) {
      console.log(`    └─ Install hint: ${server.installHint}`);
    }
  }
  return 0;
}
