import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { handleMcpMessage, BoundedLineTransform, startMcpServer } from "../core/mcp";
import {
  registerProject,
  ProjectLock,
  atomicWriteJson,
  loadProjectIndex,
  getProjectMeta,
  listRegisteredProjects,
  getProjectIndexPath,
  getProjectMetaPath,
} from "../core/registry";
import { isSensitiveFile, isBinaryFile, indexProject } from "../core/indexer";

describe("Phase 6 & 7: Model Context Protocol (MCP) Protocol & Tools", () => {
  it("correctly responds to initialize request with protocolVersion and serverInfo", async () => {
    const res = await handleMcpMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });

    expect(res).not.toBeNull();
    expect(res?.id).toBe(1);
    const result = res?.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2024-11-05");
    expect((result.serverInfo as Record<string, unknown>).name).toBe("kai-mcp-server");
  });

  it("exposes all required project intelligence tools in tools/list", async () => {
    const res = await handleMcpMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    expect(res).not.toBeNull();
    const result = res?.result as { tools: Array<{ name: string }> };
    const toolNames = result.tools.map((t) => t.name);

    expect(toolNames).toContain("kai_project_info");
    expect(toolNames).toContain("kai_search_code");
    expect(toolNames).toContain("kai_find_symbol");
    expect(toolNames).toContain("kai_get_dependencies");
    expect(toolNames).toContain("kai_get_context");
    expect(toolNames).toContain("kai_refresh_index");
  });

  it("validates arguments and returns JSON-RPC error for unknown tool", async () => {
    const res = await handleMcpMessage({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: {
        name: "unknown_arbitrary_tool",
        arguments: {},
      },
    });

    expect(res?.error).toBeDefined();
    expect(res?.error?.code).toBe(-32601);
  });

  it("rejects invalid query in kai_search_code", async () => {
    const res = await handleMcpMessage({
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: {
        name: "kai_search_code",
        arguments: { query: "" },
      },
    });

    expect(res?.error).toBeDefined();
    expect(res?.error?.message).toContain("query parameter is required");
  });
});

describe("Phase 9 & 10: Security, Sanitization & Concurrency Safeguards", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-security-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("excludes sensitive files by pattern matching", () => {
    expect(isSensitiveFile(".env")).toBe(true);
    expect(isSensitiveFile(".env.local")).toBe(true);
    expect(isSensitiveFile(".env.production")).toBe(true);
    expect(isSensitiveFile("id_rsa")).toBe(true);
    expect(isSensitiveFile("id_ed25519")).toBe(true);
    expect(isSensitiveFile("credentials.json")).toBe(true);
    expect(isSensitiveFile("secrets.json")).toBe(true);
    expect(isSensitiveFile("app.key")).toBe(true);

    // Regular files must not be excluded
    expect(isSensitiveFile("app.ts")).toBe(false);
    expect(isSensitiveFile("package.json")).toBe(false);
    expect(isSensitiveFile("README.md")).toBe(false);
  });

  it("detects binary files by extension and null byte presence", () => {
    expect(isBinaryFile("image.png")).toBe(true);
    expect(isBinaryFile("binary.exe")).toBe(true);
    expect(isBinaryFile("doc.pdf")).toBe(true);

    // Text buffer
    const textBuf = Buffer.from('console.log("hello");');
    expect(isBinaryFile("hello.js", textBuf)).toBe(false);

    // Binary buffer with null byte
    const binBuf = Buffer.from([0x68, 0x65, 0x00, 0x6c, 0x6f]);
    expect(isBinaryFile("data.dat", binBuf)).toBe(true);
  });

  it("enforces atomic JSON writes via temp file and atomic rename", () => {
    const targetFile = path.join(tmpDir, "data.json");
    atomicWriteJson(targetFile, { test: 123, status: "ok" });

    expect(fs.existsSync(targetFile)).toBe(true);
    const content = JSON.parse(fs.readFileSync(targetFile, "utf-8"));
    expect(content.test).toBe(123);
    expect(content.status).toBe("ok");
  });

  it("protects concurrent indexing via ProjectLock", () => {
    const lock1 = new ProjectLock("test-lock-proj");
    const lock2 = new ProjectLock("test-lock-proj");

    const acquired1 = lock1.acquire(500);
    expect(acquired1).toBe(true);

    // Second lock acquisition should fail / time out
    const acquired2 = lock2.acquire(200);
    expect(acquired2).toBe(false);

    // Once released, second lock can acquire
    lock1.release();
    const acquired3 = lock2.acquire(500);
    expect(acquired3).toBe(true);
    lock2.release();
  });

  it("never follows symlinks pointing outside the project root during indexing", async () => {
    const projectRoot = path.join(tmpDir, "safe-project");
    const outsideSecretDir = path.join(tmpDir, "outside-secret");

    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(outsideSecretDir, { recursive: true });

    // Put a secret outside project
    fs.writeFileSync(path.join(outsideSecretDir, "secret.txt"), "SUPER_SECRET_VALUE");
    // Put a normal file inside
    fs.writeFileSync(path.join(projectRoot, "index.ts"), "export const a = 1;");

    // Create a symlink inside project pointing outside
    try {
      fs.symlinkSync(outsideSecretDir, path.join(projectRoot, "leaked-symlink"), "dir");
    } catch {
      // If symlink creation not permitted on this environment, skip symlink assertion
      return;
    }

    const meta = registerProject(projectRoot);
    const index = await indexProject(meta);

    // Assert that the symlinked outside file was NOT indexed!
    const indexedPaths = Object.keys(index.files);
    expect(indexedPaths).toContain("index.ts");
    expect(indexedPaths).not.toContain("leaked-symlink/secret.txt");
  });

  it("BoundedLineTransform rejects oversized lines before unbounded memory buffering", async () => {
    let oversizedCount = 0;
    const transform = new BoundedLineTransform(50, () => {
      oversizedCount++;
    });

    const receivedChunks: Buffer[] = [];
    transform.on("data", (chunk: Buffer) => receivedChunks.push(chunk));

    // Send a chunk exceeding 50 bytes without a newline
    const longChunk = Buffer.from("A".repeat(120));
    transform.write(longChunk);

    expect(oversizedCount).toBe(1);
    // Buffered data passed through should not contain the discarded overflow
    const totalPassed = receivedChunks.reduce((acc, c) => acc + c.length, 0);
    expect(totalPassed).toBeLessThanOrEqual(50);

    // Now send a newline and normal short command
    transform.write(Buffer.from("\nvalid line\n"));
    transform.end();

    const outputStr = Buffer.concat(receivedChunks).toString("utf-8");
    expect(outputStr).toContain("valid line");
  });

  it("executes an end-to-end MCP stream session with multiple requests and responses", async () => {
    const projectRoot = path.join(tmpDir, "stream-project");
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "src", "app.ts"),
      "export function startApp() { return 'ready'; }"
    );

    const { PassThrough } = await import("stream");
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();

    const responses: Array<Record<string, unknown>> = [];
    outputStream.on("data", (chunk: Buffer) => {
      const lines = chunk.toString("utf-8").split("\n").filter(Boolean);
      for (const l of lines) {
        try {
          responses.push(JSON.parse(l));
        } catch {
          // ignore
        }
      }
    });

    // Start server with mock streams
    const serverPromise = startMcpServer(projectRoot, inputStream, outputStream);

    // Send initialize
    inputStream.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n");
    // Send initialized notification
    inputStream.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
    );
    // Call tool
    inputStream.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "kai_find_symbol", arguments: { name: "startApp" } },
      }) + "\n"
    );

    // Give microtask tick to process
    await new Promise((r) => setTimeout(r, 100));

    inputStream.end();
    await serverPromise;

    expect(responses.length).toBeGreaterThanOrEqual(2);
    expect(responses[0].id).toBe(1);
    expect((responses[0].result as Record<string, unknown>).protocolVersion).toBe("2024-11-05");
    expect(responses[1].id).toBe(2);
    const content = (responses[1].result as { content: Array<{ text: string }> }).content[0].text;
    expect(content).toContain("startApp");
  });

  describe("Adversarial MCP Protocol & Input Validation", () => {
    it("rejects non-object or null JSON-RPC payloads with -32600", async () => {
      const nullRes = await handleMcpMessage(null as any);
      expect(nullRes?.error?.code).toBe(-32600);
      expect(nullRes?.error?.message).toContain("expected JSON-RPC object");

      const arrayRes = await handleMcpMessage([1, 2, 3] as any);
      expect(arrayRes?.error?.code).toBe(-32600);
      expect(arrayRes?.error?.message).toContain("expected JSON-RPC object");

      const stringRes = await handleMcpMessage("malformed string" as any);
      expect(stringRes?.error?.code).toBe(-32600);
      expect(stringRes?.error?.message).toContain("expected JSON-RPC object");

      const numRes = await handleMcpMessage(12345 as any);
      expect(numRes?.error?.code).toBe(-32600);
      expect(numRes?.error?.message).toContain("expected JSON-RPC object");
    });

    it("rejects invalid jsonrpc version or malformed method", async () => {
      const wrongVersion = await handleMcpMessage({
        jsonrpc: "1.0",
        id: 1,
        method: "initialize",
      } as any);
      expect(wrongVersion?.error?.code).toBe(-32600);
      expect(wrongVersion?.error?.message).toContain("jsonrpc must be '2.0'");

      const emptyMethod = await handleMcpMessage({
        jsonrpc: "2.0",
        id: 2,
        method: "",
      });
      expect(emptyMethod?.error?.code).toBe(-32600);
      expect(emptyMethod?.error?.message).toContain("method must be a non-empty string");

      const nullMethod = await handleMcpMessage({
        jsonrpc: "2.0",
        id: 3,
        method: null as any,
      });
      expect(nullMethod?.error?.code).toBe(-32600);
      expect(nullMethod?.error?.message).toContain("method must be a non-empty string");
    });

    it("rejects non-object params for tools/call", async () => {
      const invalidParams = await handleMcpMessage({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: "not an object" as any,
      });
      expect(invalidParams?.error?.code).toBe(-32602);
      expect(invalidParams?.error?.message).toContain("params must be an object");

      const nullParams = await handleMcpMessage({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: null as any,
      });
      expect(nullParams?.error?.code).toBe(-32602);
      expect(nullParams?.error?.message).toContain("params must be an object");
    });

    it("rejects malicious or oversized projectPath in tool calls", async () => {
      // Null byte injection attempt
      const nullByteRes = await handleMcpMessage({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "kai_project_info",
          arguments: { projectPath: "/etc/passwd\0malicious" },
        },
      });
      expect(nullByteRes?.error?.code).toBe(-32602);
      expect(nullByteRes?.error?.message).toContain(
        "contains null bytes or exceeds maximum length"
      );

      // Excessive length path
      const oversizedPathRes = await handleMcpMessage({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "kai_project_info",
          arguments: { projectPath: "/path/" + "x".repeat(5000) },
        },
      });
      expect(oversizedPathRes?.error?.code).toBe(-32602);
      expect(oversizedPathRes?.error?.message).toContain(
        "contains null bytes or exceeds maximum length"
      );
    });

    it("BoundedLineTransform suppresses entire oversized line from downstream output", () => {
      let oversized = false;
      const transform = new BoundedLineTransform(40, () => {
        oversized = true;
      });

      const outputs: Buffer[] = [];
      transform.on("data", (chunk: Buffer) => outputs.push(chunk));

      // Write oversized line in two chunks without newline
      transform.write(Buffer.from("A".repeat(30)));
      transform.write(Buffer.from("B".repeat(30)));
      expect(oversized).toBe(true);

      // Downstream should have received zero bytes so far
      expect(outputs.length).toBe(0);

      // Finish the oversized line and send a clean line
      transform.write(Buffer.from("C\n"));
      expect(outputs.length).toBe(0);

      transform.write(Buffer.from("clean message\n"));
      transform.end();

      const combined = Buffer.concat(outputs).toString("utf-8");
      expect(combined).toBe("clean message\n");
    });
  });

  describe("Index and Metadata Deserialization Hardening & Corruption Recovery", () => {
    it("gracefully returns null when index.json contains malformed JSON syntax", () => {
      const projDir = path.join(tmpDir, "corrupt-json-proj");
      fs.mkdirSync(projDir, { recursive: true });
      const meta = registerProject(projDir);
      const indexPath = getProjectIndexPath(meta.id);
      fs.writeFileSync(indexPath, "{ broken json syntax !!! ");

      const result = loadProjectIndex(meta.id);
      expect(result).toBeNull();
    });

    it("gracefully returns null when index.json fails schema validation", () => {
      const projDir = path.join(tmpDir, "invalid-schema-proj");
      fs.mkdirSync(projDir, { recursive: true });
      const meta = registerProject(projDir);
      const indexPath = getProjectIndexPath(meta.id);

      // Missing required symbolIndex and files is not an object
      fs.writeFileSync(
        indexPath,
        JSON.stringify({
          meta: { id: meta.id, name: "test", canonicalPath: projDir },
          files: "not an object",
        })
      );

      const result = loadProjectIndex(meta.id);
      expect(result).toBeNull();
    });

    it("gracefully returns null when meta.json is corrupted or invalid", () => {
      const projDir = path.join(tmpDir, "corrupt-meta-proj");
      fs.mkdirSync(projDir, { recursive: true });
      const meta = registerProject(projDir);
      const metaPath = getProjectMetaPath(meta.id);

      // Malformed syntax
      fs.writeFileSync(metaPath, "<<<not json>>>");
      expect(getProjectMeta(meta.id)).toBeNull();

      // Schema mismatch (missing required string fields)
      fs.writeFileSync(metaPath, JSON.stringify({ id: 12345, name: true }));
      expect(getProjectMeta(meta.id)).toBeNull();
    });

    it("listRegisteredProjects safely ignores corrupted project meta entries", () => {
      const projDir1 = path.join(tmpDir, "valid-proj");
      fs.mkdirSync(projDir1, { recursive: true });
      const meta1 = registerProject(projDir1);

      const projDir2 = path.join(tmpDir, "corrupt-meta-in-list");
      fs.mkdirSync(projDir2, { recursive: true });
      const meta2 = registerProject(projDir2);
      fs.writeFileSync(getProjectMetaPath(meta2.id), "CORRUPT JSON NOT VALID");

      const projects = listRegisteredProjects();
      expect(Array.isArray(projects)).toBe(true);
      expect(projects.some((p) => p.id === meta1.id)).toBe(true);
      expect(projects.some((p) => p.id === meta2.id)).toBe(false);
    });
  });
});
