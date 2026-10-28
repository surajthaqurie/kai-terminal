import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  KNOWN_LSP_SERVERS,
  detectInstalledLspServers,
  isCommandAvailable,
  encodeLspMessage,
  decodeLspMessage,
  queryLspCrossFileReferences,
} from "../core/lspBridge";

/**
 * Fault-injection control for child_process.spawn, declared via vi.hoisted so
 * the hoisted vi.mock factory below can read it. All modes keep execSync and
 * the filesystem probes real; only spawn behavior is altered.
 */
const spawnControl = vi.hoisted(() => ({
  mode: "real" as "real" | "throwSync" | "hang" | "crash",
  killCalls: 0,
}));

vi.mock("child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("child_process")>();
  const realSpawn = orig.spawn.bind(orig);
  function fakeHangingChild() {
    return {
      stdin: { write: () => true, end: () => {} },
      stdout: { on: () => {} },
      kill: () => {
        spawnControl.killCalls += 1;
        return true;
      },
      on: () => {},
    };
  }
  function fakeCrashingChild() {
    const child = {
      stdin: { write: () => true, end: () => {} },
      stdout: { on: () => {} },
      kill: () => true,
      on: (event: string, cb: (...args: unknown[]) => void) => {
        if (event === "close") {
          setTimeout(() => cb(1, null), 10);
        }
        return child;
      },
    };
    return child;
  }
  return {
    ...orig,
    spawn: ((...args: Parameters<typeof orig.spawn>) => {
      if (spawnControl.mode === "throwSync") throw new Error("injected sync spawn failure");
      if (spawnControl.mode === "hang") return fakeHangingChild();
      if (spawnControl.mode === "crash") return fakeCrashingChild();
      return (realSpawn as (...a: unknown[]) => unknown)(...args);
    }) as typeof orig.spawn,
  };
});

const EXT_FOR_LANGUAGE: Record<string, string> = {
  typescript: "probe.ts",
  rust: "probe.rs",
  python: "probe.py",
  go: "probe.go",
};

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
    expect(decodeLspMessage('Content-Length: 100\r\n\r\n{"short":1}')).toBeNull();
    expect(decodeLspMessage("Content-Length: invalid\r\n\r\n{}")).toBeNull();
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

describe("LSP Bridge: degraded-contract hardening (KNOWN_LIMITATIONS 1.8.1)", () => {
  beforeEach(() => {
    spawnControl.mode = "real";
    spawnControl.killCalls = 0;
  });

  it("missing-server path carries the full degraded contract deterministically", async () => {
    const missing = KNOWN_LSP_SERVERS.find((e) => !isCommandAvailable(e.command));
    if (!missing) return; // every catalogued server installed: degraded path unreachable here
    const result = await queryLspCrossFileReferences(
      process.cwd(),
      EXT_FOR_LANGUAGE[missing.language] ?? "probe.ts",
      1,
      0,
      "SomeSymbol",
      1000
    );
    expect(result.isAvailable).toBe(false);
    expect(result.serverUsed).toBe("none");
    expect(result.references).toEqual([]);
    expect(result.definitions).toEqual([]);
    expect(result.degradedMode).toBe(true);
    expect(result.degradedReason).toContain("degraded mode");
    expect(result.degradedReason).toContain(missing.command);
    expect(result.error).toBeDefined();
  });

  it("synchronous spawn failure still reports degradedMode (never a silent miss)", async () => {
    // .rs resolves to rust-analyzer where installed, so lookup succeeds and the
    // mocked spawn throw below reaches the synchronous-failure catch block. Where
    // no server exists, this exercises the missing-server path, which carries the
    // same contract.
    spawnControl.mode = "throwSync";
    const result = await queryLspCrossFileReferences(
      process.cwd(),
      "probe.rs",
      1,
      0,
      "SomeSymbol",
      1000
    );
    expect(result.references).toEqual([]);
    expect(result.definitions).toEqual([]);
    expect(result.degradedMode).toBe(true);
    expect(result.degradedReason).toBeDefined();
  });

  it("unresponsive server resolves in degraded mode within the timeout and is reaped", async () => {
    const present = KNOWN_LSP_SERVERS.find((e) => isCommandAvailable(e.command));
    if (!present) return; // no live server here: timeout path unreachable
    spawnControl.mode = "hang";
    const start = Date.now();
    const result = await queryLspCrossFileReferences(
      process.cwd(),
      EXT_FOR_LANGUAGE[present.language] ?? "probe.ts",
      1,
      0,
      "SomeSymbol",
      300
    );
    const elapsed = Date.now() - start;
    expect(result.isAvailable).toBe(true);
    expect(result.serverUsed).toBe(present.command);
    expect(result.references).toEqual([]);
    expect(result.definitions).toEqual([]);
    expect(result.degradedMode).toBe(true);
    expect(result.degradedReason).toContain("timed out");
    expect(elapsed).toBeLessThan(3000);
    expect(spawnControl.killCalls).toBeGreaterThanOrEqual(1);
  });

  it("crashing server immediately resolves in degraded mode without waiting for timeout", async () => {
    const present = KNOWN_LSP_SERVERS.find((e) => isCommandAvailable(e.command));
    if (!present) return;
    spawnControl.mode = "crash";
    const start = Date.now();
    const result = await queryLspCrossFileReferences(
      process.cwd(),
      EXT_FOR_LANGUAGE[present.language] ?? "probe.ts",
      1,
      0,
      "SomeSymbol",
      4000
    );
    const elapsed = Date.now() - start;
    expect(result.degradedMode).toBe(true);
    expect(result.degradedReason).toContain("exited with code 1");
    expect(elapsed).toBeLessThan(1000);
  });
});
