import fs from "fs";
import { ensureKaiDirectories } from "../../core/registry";
import { kaiConfigPath, loadKaiConfig } from "../kaiConfig";

/** Hidden compat: `kai config [list|get|set]` (prefer `kai list -c`). */
export async function runConfig(args: string[]): Promise<number> {
  const sub = args[1] || "list";
  const currentConfig = loadKaiConfig();

  const ALLOWED_KEYS = new Set([
    "defaultTokenBudget",
    "maxFileSizeBytes",
    "indexingDepth",
    "telemetryLocal",
  ]);

  if (sub === "list") {
    console.log(`[kai] Current Configuration:`);
    console.log(JSON.stringify(currentConfig, null, 2));
    return 0;
  }

  if (sub === "get") {
    const key = args[2];
    if (!key) {
      console.error(`[kai] Error: Please specify a configuration key.`);
      return 1;
    }
    if (!ALLOWED_KEYS.has(key)) {
      console.error(
        `[kai] Error: Unknown configuration key "${key}". Allowed: ${[...ALLOWED_KEYS].join(", ")}`
      );
      return 1;
    }
    console.log(`${key} = ${currentConfig[key]}`);
    return 0;
  }

  if (sub === "set") {
    const key = args[2];
    const val = args[3];
    if (!key || val === undefined) {
      console.error(`[kai] Error: Usage: kai config set <key> <value>`);
      return 1;
    }
    if (!ALLOWED_KEYS.has(key)) {
      console.error(
        `[kai] Error: Unknown configuration key "${key}". Allowed: ${[...ALLOWED_KEYS].join(", ")}`
      );
      return 1;
    }
    let parsed: unknown = val;
    if (key === "telemetryLocal") {
      if (val === "true") parsed = true;
      else if (val === "false") parsed = false;
      else {
        console.error(`[kai] Error: ${key} must be "true" or "false".`);
        return 1;
      }
    } else {
      const num = Number(val);
      if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0 || num > 1000000) {
        console.error(`[kai] Error: ${key} must be a positive integer (1-1000000).`);
        return 1;
      }
      parsed = num;
    }
    currentConfig[key] = parsed;
    // First-run safety: KAI_HOME may not exist yet (no project has been
    // registered). Previously this threw ENOENT on a fresh machine.
    ensureKaiDirectories();
    fs.writeFileSync(kaiConfigPath(), JSON.stringify(currentConfig, null, 2), { mode: 0o600 });
    console.log(`[kai] Configuration updated: ${key} = ${val}`);
    return 0;
  }

  console.error(`[kai] Unknown config subcommand: ${sub}`);
  return 1;
}
