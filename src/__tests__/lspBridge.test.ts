import { describe, it, expect } from "vitest";
import {
  KNOWN_LSP_SERVERS,
  detectInstalledLspServers,
  isCommandAvailable,
  encodeLspMessage,
  decodeLspMessage,
  queryLspCrossFileReferences,
} from "../core/lspBridge";

describe("LSP Bridge: Probing, Protocol & Fallbacks", () => {
  it("catalogues known LSP server binaries with install hints", () => {
    expect(KNOWN_LSP_SERVERS.length).toBeGreaterThanOrEqual(4);
    const languages = KNOWN_LSP_SERVERS.map((s) => s.language);
    expect(languages).toContain("typescript");
    expect(languages).toContain("rust");
    expect(languages).toContain("python");
    expect(languages).toContain("go");

    for (const server of KNOWN_LSP_SERVERS) {
      expect(server.command).toBeDefined();
      expect(server.installHint).toBeDefined();
    }
  });

  it("correctly probes binary availability on the system PATH without crashing", () => {
    // node is guaranteed to be available in this test runner
    expect(isCommandAvailable("node")).toBe(true);
    // Non-existent command should return false
    expect(isCommandAvailable("non_existent_binary_xyz_12345")).toBe(false);
  });

  it("detectInstalledLspServers returns structured availability reports for all languages", () => {
    const detected = detectInstalledLspServers();
    expect(detected.length).toBe(KNOWN_LSP_SERVERS.length);

    for (const item of detected) {
      expect(typeof item.isAvailable).toBe("boolean");
      expect(typeof item.command).toBe("string");
      expect(typeof item.language).toBe("string");
    }
  });

  it("encodes and decodes LSP JSON-RPC messages with Content-Length headers", () => {
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "textDocument/definition",
      params: { test: true },
    };

    const encoded = encodeLspMessage(payload);
    expect(encoded).toContain("Content-Length:");
    expect(encoded).toContain("\r\n\r\n");

    const decoded = decodeLspMessage(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.id).toBe(1);
    expect(decoded?.method).toBe("textDocument/definition");
  });

  it("handles malformed LSP response strings safely", () => {
    expect(decodeLspMessage("invalid text without headers")).toBeNull();
    expect(decodeLspMessage("Content-Length: 10\r\n\r\nnot json")).toBeNull();
  });

  it("safely handles queries when an LSP server is missing without crashing or erroring out", async () => {
    const result = await queryLspCrossFileReferences(
      process.cwd(),
      "src/App.tsx",
      10,
      5,
      "App",
      1000
    );

    // If typescript-language-server is not installed, it should gracefully report isAvailable: false
    // If it is installed, it handles it safely
    expect(result.symbolName).toBe("App");
    expect(typeof result.isAvailable).toBe("boolean");
    expect(Array.isArray(result.references)).toBe(true);
    expect(Array.isArray(result.definitions)).toBe(true);
  });
});
