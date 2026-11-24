/**
 * Entry point of the Shared Agent engine (`dist/cli/shared-agent.js`). Only the
 * desktop app starts it; it is not a `kai` command. See `core/sharedAgent/serve.ts`.
 */
import { runEngine } from "../core/sharedAgent/serve";
import { hardenExecutableLookup } from "../core/spawnSafety";
import { KAI_VERSION } from "./constants";

// Before the engine can spawn anything (agent binaries, taskkill): never look
// in the working directory for executables on Windows.
hardenExecutableLookup();

void runEngine({ service: { version: KAI_VERSION } }).then((code) => process.exit(code));
