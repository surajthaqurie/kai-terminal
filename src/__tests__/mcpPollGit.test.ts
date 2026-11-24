import { PassThrough } from "stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * RES-02: an idle `kai mcp` server polls (every 2 s) which integration tools its project is
 * bound to. Each poll used to spawn a synchronous `git rev-parse --show-toplevel`: about
 * 1,800 spawns an hour per agent session, each blocking the event loop. Here the poll runs
 * at 20 ms and every `git` the server starts is counted: the number must not grow with time.
 */
const gitCalls: string[][] = [];

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    execFileSync: ((command: string, args?: readonly string[], ...rest: unknown[]) => {
      if (command === "git") gitCalls.push([...(args ?? [])]);
      return (actual.execFileSync as (...a: unknown[]) => unknown)(command, args, ...rest);
    }) as typeof actual.execFileSync,
  };
});

import { projectRootFor, removeBinding, writeBinding } from "../core/integrations/config";
import { startMcpServer } from "../core/mcp";
import { makeRepo, useTempKaiHome } from "./helpers/integrationsEnv";

let env: ReturnType<typeof useTempKaiHome>;
let dir = "";
let cleanup = () => {};
let savedPoll: string | undefined;

beforeEach(() => {
  env = useTempKaiHome();
  const repo = makeRepo();
  dir = repo.dir;
  cleanup = repo.cleanup;
  savedPoll = process.env.KAI_MCP_TOOLS_POLL_MS;
  process.env.KAI_MCP_TOOLS_POLL_MS = "20";
  gitCalls.length = 0;
});

afterEach(() => {
  if (savedPoll === undefined) delete process.env.KAI_MCP_TOOLS_POLL_MS;
  else process.env.KAI_MCP_TOOLS_POLL_MS = savedPoll;
  cleanup();
  env.restore();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: Array<{ id?: number; method?: string }> = [];
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) messages.push(JSON.parse(line));
    }
  });
  const done = startMcpServer(dir, input, output);
  const send = (m: object) => input.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const changed = () => messages.filter((m) => m.method === "notifications/tools/list_changed");
  return {
    send,
    messages,
    changed,
    stop: async () => {
      input.end();
      await done;
    },
  };
}

describe("an idle MCP server does not keep spawning git", () => {
  it("polls for binding changes without a git process per poll", async () => {
    const s = startServer();
    s.send({ id: 1, method: "initialize" });
    s.send({ method: "notifications/initialized" });
    await sleep(150);
    const afterStartup = gitCalls.length;

    await sleep(1000); // about 50 polls at 20 ms: the old code spawned git on every one
    expect(gitCalls.length).toBe(afterStartup);
    await s.stop();
  });

  it("still notices a binding that appears or disappears while it is idle", async () => {
    const s = startServer();
    s.send({ id: 1, method: "initialize" });
    s.send({ method: "notifications/initialized" });
    await sleep(100);
    expect(s.changed()).toHaveLength(0);

    writeBinding(projectRootFor(dir), {
      provider: "azure-devops",
      account: "azure-devops:Contoso",
      project: "My Project",
      repo: "api",
      boundAt: "2026-11-01T00:00:00.000Z",
    });
    const deadline = Date.now() + 3000;
    while (s.changed().length < 1 && Date.now() < deadline) await sleep(15);
    expect(s.changed()).toHaveLength(1);

    removeBinding(projectRootFor(dir));
    while (s.changed().length < 2 && Date.now() < deadline + 3000) await sleep(15);
    expect(s.changed()).toHaveLength(2);
    await s.stop();
  });

  it("findBinding uses a top-level the caller already knows instead of asking git", async () => {
    const { findBinding } = await import("../core/integrations/config");
    const top = projectRootFor(dir);
    gitCalls.length = 0;
    findBinding(dir, top);
    findBinding(dir, top);
    expect(gitCalls).toHaveLength(0);
    findBinding(dir); // without it, it still asks (a one-off lookup is fine)
    expect(gitCalls.length).toBeGreaterThan(0);
  });
});
