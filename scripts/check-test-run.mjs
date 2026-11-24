#!/usr/bin/env node
/**
 * Fails a test run that silently left test files out.
 *
 *   node scripts/check-test-run.mjs <vitest-json-report>
 *
 * Seen on a loaded machine: a full `vitest run` dropped `appShell.test.tsx` (102 tests) from its
 * results entirely and still reported success with zero failures. CI only sees "passed", so the
 * file's tests would simply stop counting. This compares the report with the files Vitest's own
 * config selects (`vitest list --filesOnly`, same include/exclude rules) and fails, naming them,
 * when any is missing. Skipped files still appear in the report, so they do not trip it.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Forward slashes and, on Windows, one case, so both lists compare by path. */
export function normalizePath(file, platform = process.platform) {
  const forward = String(file).replace(/\\/g, "/");
  return platform === "win32" ? forward.toLowerCase() : forward;
}

/** Test files Vitest selected but the report has no result for. */
export function missingFiles(listed, report, platform = process.platform) {
  const ran = new Set((report.testResults ?? []).map((r) => normalizePath(r.name, platform)));
  return listed.filter((file) => !ran.has(normalizePath(file, platform)));
}

function main() {
  const reportPath = process.argv[2];
  if (!reportPath) {
    console.error("usage: node scripts/check-test-run.mjs <vitest-json-report>");
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(resolve(reportPath), "utf8"));
  // Fixed arguments; a single command string because npx is a .cmd shim on Windows.
  const listed = JSON.parse(
    execSync("npx vitest list --filesOnly --json", {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
  ).map((entry) => entry.file);
  const missing = missingFiles(listed, report);
  if (missing.length > 0) {
    console.error(
      `Test run incomplete: ${missing.length} of ${listed.length} test files have no results ` +
        `(the run still reported ${report.numFailedTests ?? "?"} failures):`
    );
    for (const file of missing) console.error(`  - ${file}`);
    console.error("Run them on their own to see why (often a worker that failed to start).");
    process.exit(1);
  }
  console.log(
    `Test run complete: all ${listed.length} test files reported (${report.numPassedTests} passed).`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
