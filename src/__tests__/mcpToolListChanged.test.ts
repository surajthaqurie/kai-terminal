import { PassThrough } from "stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectRootFor, removeBinding, writeBinding } from "../core/integrations/config";
import { handleMcpMessage, startMcpServer } from "../core/mcp";
import { makeRepo, useTempKaiHome } from "./helpers/integrationsEnv";

type Msg = { id?: number; method?: string; result?: Record<string, unknown> };

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
});

afterEach(() => {
  if (savedPoll === undefined) delete process.env.KAI_MCP_TOOLS_POLL_MS;
  else process.env.KAI_MCP_TOOLS_POLL_MS = savedPoll;
  cleanup();
  env.restore();
});

function bindAzure(): void {
  writeBinding(projectRootFor(dir), {
    provider: "azure-devops",
    account: "azure-devops:Contoso",
    project: "My Project",
    repo: "api",
    boundAt: "2026-11-01T00:00:00.000Z",
  });
}

function startServer() {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: Msg[] = [];
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) messages.push(JSON.parse(line) as Msg);
    }
  });
  const done = startMcpServer(dir, input, output);
  const send = (m: object) => input.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const changed = () => messages.filter((m) => m.method === "notifications/tools/list_changed");
  const waitFor = async (ok: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 15));
    return ok();
  };
  const stop = async () => {
    input.end();
    await done;
  };
  return { send, messages, changed, waitFor, stop };
}

describe("tools/list_changed", () => {
  it("advertises that the tool list can change", async () => {
    const res = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const caps = (res?.result as { capabilities: { tools: { listChanged?: boolean } } })
      .capabilities;
    expect(caps.tools.listChanged).toBe(true);
  });

  it("tells a connected client when an integration is connected, and when it is removed", async () => {
    const s = startServer();
    s.send({ id: 1, method: "initialize" });
    s.send({ method: "notifications/initialized" });
    await s.waitFor(() => s.messages.some((m) => m.id === 1));

    // Nothing changed yet: no notification.
    await new Promise((r) => setTimeout(r, 120));
    expect(s.changed()).toHaveLength(0);

    bindAzure();
    expect(await s.waitFor(() => s.changed().length === 1)).toBe(true);

    // A fresh tools/list now carries the integration tools the client was told about.
    s.send({ id: 2, method: "tools/list" });
    await s.waitFor(() => s.messages.some((m) => m.id === 2));
    const names = (
      s.messages.find((m) => m.id === 2)?.result as { tools: Array<{ name: string }> }
    ).tools.map((t) => t.name);
    expect(names).toContain("kai_integration_status");

    // Unchanged again: still one notification, not one per poll.
    await new Promise((r) => setTimeout(r, 120));
    expect(s.changed()).toHaveLength(1);

    removeBinding(projectRootFor(dir));
    expect(await s.waitFor(() => s.changed().length === 2)).toBe(true);
    await s.stop();
  });

  it("stays quiet until the client has sent initialized", async () => {
    const s = startServer();
    s.send({ id: 1, method: "initialize" });
    await s.waitFor(() => s.messages.some((m) => m.id === 1));
    bindAzure();
    await new Promise((r) => setTimeout(r, 150));
    expect(s.changed()).toHaveLength(0);
    await s.stop();
  });

  it("does not poll when KAI_MCP_TOOLS_POLL_MS is 0", async () => {
    process.env.KAI_MCP_TOOLS_POLL_MS = "0";
    const s = startServer();
    s.send({ id: 1, method: "initialize" });
    s.send({ method: "notifications/initialized" });
    await s.waitFor(() => s.messages.some((m) => m.id === 1));
    bindAzure();
    await new Promise((r) => setTimeout(r, 150));
    expect(s.changed()).toHaveLength(0);
    await s.stop();
  });
});
