import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { httpRequest, redactSecrets } from "../core/integrations/http";
import {
  CompositeSecretStore,
  DpapiSecretStore,
  FileSecretStore,
  KeychainSecretStore,
  SecretToolStore,
  secretKeyFor,
  type RunResult,
  type Runner,
  type SecretStore,
} from "../core/integrations/secretStore";
import { IntegrationError } from "../core/integrations/types";
import { MemorySecrets, useTempKaiHome } from "./helpers/integrationsEnv";

const ok = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "application/json" }, ...init });

describe("httpRequest", () => {
  it("retries a throttled call after the server's Retry-After, then succeeds", async () => {
    const waits: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(ok('{"a":1}'));
    const res = await httpRequest(
      { url: "https://x.test/a" },
      { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async (ms) => void waits.push(ms) }
    );
    expect(res.json()).toEqual({ a: 1 });
    expect(waits).toEqual([2000]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up with rate_limited after the retry budget", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 429 }));
    await expect(
      httpRequest(
        { url: "https://x.test/a" },
        { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} }
      )
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["an HTTP 203 sign-in page", new Response("<html>sign in</html>", { status: 203 })],
    [
      "a redirect to a login page",
      new Response("", { status: 302, headers: { location: "https://login" } }),
    ],
    [
      "an HTML 200",
      new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
    ],
    ["a 401", new Response("", { status: 401 })],
  ])("reports %s as an auth failure with the provider's hint", async (_name, response) => {
    const fetchImpl = vi.fn(async () => response);
    const err = await httpRequest(
      { url: "https://x.test/a", authHint: "Run `kai integration azure`." },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    ).catch((e) => e);
    expect(err).toBeInstanceOf(IntegrationError);
    expect(err).toMatchObject({ code: "auth", hint: "Run `kai integration azure`." });
  });

  it("maps 403 and 404 and never echoes the credential from an error body", async () => {
    const secret = "pat-very-secret-123";
    const forbidden = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: `token ${secret} lacks scope` }), { status: 403 })
    );
    const err = await httpRequest(
      { url: "https://x.test/a", redact: [secret] },
      { fetchImpl: forbidden as unknown as typeof fetch }
    ).catch((e) => e);
    expect(err.code).toBe("forbidden");
    expect(err.message).not.toContain(secret);
    expect(err.message).toContain("[redacted]");

    const missing = vi.fn(async () => new Response("{}", { status: 404 }));
    await expect(
      httpRequest({ url: "https://x.test/a" }, { fetchImpl: missing as unknown as typeof fetch })
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses an oversized response", async () => {
    const big = vi.fn(async () => ok("x".repeat(2000)));
    await expect(
      httpRequest(
        { url: "https://x.test/a", maxBytes: 1000 },
        { fetchImpl: big as unknown as typeof fetch }
      )
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("turns a network failure into a message without request details", async () => {
    const down = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND x.test");
    });
    await expect(
      httpRequest({ url: "https://x.test/a" }, { fetchImpl: down as unknown as typeof fetch })
    ).rejects.toMatchObject({ code: "network" });
  });

  it("redactSecrets ignores very short strings", () => {
    expect(redactSecrets("a abc secret-token", ["abc", "secret-token"])).toBe("a abc [redacted]");
  });
});

describe("secret stores", () => {
  let env: ReturnType<typeof useTempKaiHome>;
  beforeEach(() => {
    env = useTempKaiHome();
  });
  afterEach(() => env.restore());

  it("derives a stable key per account", () => {
    expect(secretKeyFor("azure-devops:contoso")).toBe("kai/azure-devops/contoso");
  });

  it("FileSecretStore round-trips and deletes", async () => {
    const store = new FileSecretStore();
    expect(await store.has("k")).toBe(false);
    expect(await store.set("k", "s3cret")).toBe("file");
    expect(await store.get("k")).toBe("s3cret");
    expect(await store.has("k")).toBe(true);
    await store.delete("k");
    expect(await store.get("k")).toBeNull();
    await store.delete("k"); // deleting twice is fine
  });

  it.runIf(process.platform !== "win32")("keeps the fallback file private (0600)", async () => {
    await new FileSecretStore().set("k", "s3cret");
    const dir = path.join(env.home, "credentials");
    const [file] = fs.readdirSync(dir);
    expect(fs.statSync(path.join(dir, file)).mode & 0o777).toBe(0o600);
  });

  it("falls back to the file when the OS store throws, and still reads it back", async () => {
    const broken: SecretStore = {
      get: async () => {
        throw new Error("no dbus");
      },
      has: async () => {
        throw new Error("no dbus");
      },
      set: async () => {
        throw new Error("no dbus");
      },
      delete: async () => {
        throw new Error("no dbus");
      },
    };
    const store = new CompositeSecretStore(broken);
    expect(await store.set("k", "v")).toBe("file");
    expect(await store.get("k")).toBe("v");
    expect(await store.has("k")).toBe(true);
  });

  it("removes a stale file copy once the OS store accepts the secret", async () => {
    const file = new FileSecretStore();
    await file.set("k", "old");
    const os = new MemorySecrets();
    const store = new CompositeSecretStore(os);
    expect(await store.set("k", "new")).toBe("os");
    expect(await file.has("k")).toBe(false);
    expect(await store.get("k")).toBe("new");
  });

  it("macOS keychain and Linux secret-tool use fixed arguments", async () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = [];
    const run: Runner = async (cmd, args, opts) => {
      calls.push({ cmd, args, input: opts?.input });
      return { code: 0, stdout: "tok\n", stderr: "" } satisfies RunResult;
    };
    const mac = new KeychainSecretStore(run);
    await mac.set("kai/x/y", "tok");
    expect(await mac.get("kai/x/y")).toBe("tok");
    expect(calls[0]).toMatchObject({
      cmd: "security",
      args: ["add-generic-password", "-U", "-a", "kai", "-s", "kai/x/y", "-w", "tok"],
    });

    calls.length = 0;
    const linux = new SecretToolStore(run);
    await linux.set("kai/x/y", "tok");
    // The secret travels on stdin, never in argv.
    expect(calls[0].input).toBe("tok");
    expect(calls[0].args).not.toContain("tok");
  });

  it.runIf(process.platform === "win32")(
    "Windows DPAPI encrypts at rest and round-trips",
    async () => {
      const store = new DpapiSecretStore();
      await store.set("kai/test/dpapi", "pat-plaintext-123");
      expect(await store.has("kai/test/dpapi")).toBe(true);
      const dir = path.join(env.home, "credentials");
      const blob = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8");
      expect(blob).not.toContain("pat-plaintext-123");
      expect(await store.get("kai/test/dpapi")).toBe("pat-plaintext-123");
      await store.delete("kai/test/dpapi");
      expect(await store.get("kai/test/dpapi")).toBeNull();
    },
    30_000
  );
});
