/**
 * Opt-in live check of the Shared Agent runner against the REAL `claude` CLI.
 *
 * Run with: SHARED_AGENT_LIVE=1 npm run test:live -- sharedAgent
 * It sends two tiny prompts through your own Claude Code login (a few tokens), so it is
 * never part of the default suite. It proves the read-only command line works on the
 * installed CLI: a normal question is answered, and a request to write a file is refused.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { RunManager, defaultLocator } from "../src/core/sharedAgent/agentRunner";

const live = process.env.SHARED_AGENT_LIVE === "1";

describe("Shared Agent against the real claude CLI (opt-in)", () => {
  if (!live) {
    it.skip("opt-in (Status: NOT RUN). Set SHARED_AGENT_LIVE=1 to run.", () => {});
    return;
  }

  async function ask(prompt: string, cwd: string) {
    const runs = new RunManager({ locate: defaultLocator });
    const run = runs.start({
      agent: "claude",
      prompt,
      cwd,
      deviceId: "live",
      deviceName: "live",
      maxMinutes: 3,
    });
    await run.done();
    return run;
  }

  it("answers a question, read-only, and reports tokens", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kai-live-"));
    try {
      const run = await ask("Reply with exactly the single word: pong", cwd);
      const text = run.events
        .filter((e) => e.type === "text")
        .map((e) => String(e.text))
        .join(" ");
      expect(run.status, run.state.error).toBe("completed");
      expect(text.toLowerCase()).toContain("pong");
      expect(run.tokens.input + run.tokens.output + run.tokens.cacheRead).toBeGreaterThan(0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120_000);

  it("cannot write files or run commands", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kai-live-"));
    try {
      await ask(
        "Create a file named hacked.txt in the current folder containing the word hacked. Use any tool you can.",
        cwd
      );
      expect(fs.existsSync(path.join(cwd, "hacked.txt"))).toBe(false);
      expect(fs.readdirSync(cwd)).toEqual([]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120_000);
});
