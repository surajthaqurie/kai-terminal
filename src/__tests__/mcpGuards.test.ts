import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleMcpMessage } from "../core/mcp";
import { describeBroadRoot, getProjectMeta, resolveCanonicalPath } from "../core/registry";

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["KAI_HOME", "HOME", "USERPROFILE", "KAI_ALLOW_BROAD_ROOT"];
let sandbox: string;
let fakeHome: string;
let kaiHome: string;

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-guards-")));
  fakeHome = path.join(sandbox, "home", "me");
  kaiHome = path.join(sandbox, "kai-home");
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.writeFileSync(path.join(fakeHome, "notes.ts"), "export const n = 1;\n");
  process.env.KAI_HOME = kaiHome;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  delete process.env.KAI_ALLOW_BROAD_ROOT;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const call = (root: string, name = "kai_project_info", projectPath?: string) =>
  handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: projectPath ? { projectPath } : {} },
    },
    root
  );

const projectsDir = () => path.join(kaiHome, "projects");

describe("describeBroadRoot", () => {
  it("flags the home directory, an ancestor of it, and a filesystem root", () => {
    expect(describeBroadRoot(fakeHome, { home: fakeHome })).toBe("your home directory");
    expect(describeBroadRoot(path.dirname(fakeHome), { home: fakeHome })).toMatch(
      /contains your home/
    );
    const fsRoot = path.parse(fakeHome).root;
    expect(describeBroadRoot(fsRoot, { home: fakeHome })).toBe("a filesystem root");
    // A root on another drive is not an ancestor of home, but is still a root.
    expect(describeBroadRoot(path.parse(fakeHome).root, { home: path.join(sandbox, "x") })).toBe(
      "a filesystem root"
    );
  });

  it("accepts an ordinary project, including one inside the home directory", () => {
    const project = path.join(fakeHome, "code", "app");
    fs.mkdirSync(project, { recursive: true });
    expect(describeBroadRoot(resolveCanonicalPath(project), { home: fakeHome })).toBeNull();
    // A sibling that merely shares a name prefix with home is not home.
    const sibling = path.join(path.dirname(fakeHome), "me-too");
    fs.mkdirSync(sibling, { recursive: true });
    expect(describeBroadRoot(resolveCanonicalPath(sibling), { home: fakeHome })).toBeNull();
  });

  it("is switched off by KAI_ALLOW_BROAD_ROOT=1 and only by that exact value", () => {
    expect(
      describeBroadRoot(fakeHome, { home: fakeHome, env: { KAI_ALLOW_BROAD_ROOT: "1" } })
    ).toBeNull();
    expect(
      describeBroadRoot(fakeHome, { home: fakeHome, env: { KAI_ALLOW_BROAD_ROOT: "true" } })
    ).toBe("your home directory");
  });
});

describe("MCP refuses to index a root that is too broad", () => {
  it.each([
    ["the home directory", () => fakeHome],
    ["a folder containing the home directory", () => path.dirname(fakeHome)],
    ["a filesystem root", () => path.parse(fakeHome).root],
  ])("%s: error to the client, nothing indexed or written", async (_label, root) => {
    const res = await call(root());

    expect(res?.error?.code).toBe(-32602);
    expect(res?.error?.message).toContain("KAI_ALLOW_BROAD_ROOT=1");
    expect(res?.result).toBeUndefined();
    // No registration, no index, nothing under ~/.kai for that root.
    expect(fs.existsSync(projectsDir()) ? fs.readdirSync(projectsDir()) : []).toEqual([]);
    expect(getProjectMeta(fakeHome)).toBeNull();
  });

  it("applies to every graph tool, not only project info", async () => {
    for (const tool of ["kai_search_code", "kai_refresh_index", "kai_find_symbol"]) {
      const res = await handleMcpMessage(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: tool, arguments: { query: "n", name: "n" } },
        },
        fakeHome
      );
      expect(res?.error?.message, tool).toContain("Refusing to index");
    }
    expect(fs.existsSync(projectsDir()) ? fs.readdirSync(projectsDir()) : []).toEqual([]);
  });

  it("still serves a project folder inside the home directory", async () => {
    const project = path.join(fakeHome, "code", "app");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "a.ts"), "export function a() {}\n");

    const res = await call(fakeHome, "kai_project_info", project);

    expect(res?.error).toBeUndefined();
    expect(getProjectMeta(project)).not.toBeNull();
  });

  it("allows the broad root when KAI_ALLOW_BROAD_ROOT=1 is set", async () => {
    process.env.KAI_ALLOW_BROAD_ROOT = "1";

    const res = await call(fakeHome);

    expect(res?.error).toBeUndefined();
    expect(getProjectMeta(fakeHome)).not.toBeNull();
  });

  it("does not block initialize or tools/list for a broad root", async () => {
    const list = await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" }, fakeHome);
    expect(list?.error).toBeUndefined();
    expect(Array.isArray((list?.result as { tools: unknown[] }).tools)).toBe(true);
  });
});

describe("JSON-RPC notifications get no response", () => {
  let project: string;

  beforeEach(() => {
    project = path.join(fakeHome, "code", "app");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "a.ts"), "export function a() {}\n");
  });

  it("a tools/call without an id is executed but never answered", async () => {
    const res = await handleMcpMessage(
      { jsonrpc: "2.0", method: "tools/call", params: { name: "kai_project_info" } },
      project
    );

    expect(res).toBeNull();
    // It really ran: the project was registered by the call.
    expect(getProjectMeta(project)).not.toBeNull();
  });

  it("other requests and malformed messages without an id are not answered either", async () => {
    for (const message of [
      { jsonrpc: "2.0", method: "initialize" },
      { jsonrpc: "2.0", method: "tools/list" },
      { jsonrpc: "2.0", method: "no/such/method" },
      { jsonrpc: "1.0", method: "tools/list" },
      { jsonrpc: "2.0", method: "tools/call", params: "not-an-object" },
    ]) {
      expect(await handleMcpMessage(message, project), JSON.stringify(message)).toBeNull();
    }
  });

  it("a request WITH an id (including a null one) is still answered", async () => {
    for (const id of [0, "abc", null]) {
      const res = await handleMcpMessage({ jsonrpc: "2.0", id, method: "tools/list" }, project);
      expect(res?.id).toBe(id);
      expect(res?.error).toBeUndefined();
    }
  });

  it("a pre-delivered cancellation still answers the request with -32800", async () => {
    const cancelled = new Set<string | number>();
    expect(
      await handleMcpMessage(
        { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } },
        project,
        cancelled
      )
    ).toBeNull();
    const res = await handleMcpMessage(
      { jsonrpc: "2.0", id: 7, method: "tools/list" },
      project,
      cancelled
    );
    expect(res?.error?.code).toBe(-32800);
  });
});
