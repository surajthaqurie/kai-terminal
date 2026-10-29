import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { getKaiHomeDir } from "../registry";

/**
 * Where integration secrets (PATs) live. Nothing here ever writes a secret to
 * `config.json` or to an agent's config file.
 *
 * - Windows: DPAPI through PowerShell (encrypted for the current user).
 * - macOS: the login keychain (`security`).
 * - Linux: the Secret Service (`secret-tool`).
 * - Anything else, or when that backend fails: a `0600` file under
 *   `~/.kai/credentials`. `set` reports where it landed so the CLI can say so.
 *
 * No native modules: each backend shells out with fixed arguments, and the
 * secret travels on stdin wherever the tool allows it.
 */
export type SecretLocation = "os" | "file";

export interface SecretStore {
  get(key: string): Promise<string | null>;
  /** True when a secret exists; cheaper than `get` where the backend allows. */
  has(key: string): Promise<boolean>;
  set(key: string, value: string): Promise<SecretLocation>;
  delete(key: string): Promise<void>;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the executable could not be started (ENOENT and friends). */
  spawnError?: string;
}

export type Runner = (
  command: string,
  args: string[],
  opts?: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
) => Promise<RunResult>;

export const runProcess: Runner = (command, args, opts = {}) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(command, args, {
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stdout, stderr, spawnError: "timed out" });
    }, opts.timeoutMs ?? 20_000);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err) => finish({ code: null, stdout, stderr, spawnError: err.message }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });

function credentialsDir(): string {
  return path.join(getKaiHomeDir(), "credentials");
}

function fileNameFor(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
}

/** Plain `0600` file. The fallback of last resort, and the DPAPI blob's home. */
export class FileSecretStore implements SecretStore {
  constructor(private readonly suffix = "secret") {}

  private pathFor(key: string): string {
    return path.join(credentialsDir(), `${fileNameFor(key)}.${this.suffix}`);
  }

  async get(key: string): Promise<string | null> {
    try {
      return fs.readFileSync(this.pathFor(key), "utf8");
    } catch {
      return null;
    }
  }

  async has(key: string): Promise<boolean> {
    return fs.existsSync(this.pathFor(key));
  }

  async set(key: string, value: string): Promise<SecretLocation> {
    const dir = credentialsDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = this.pathFor(key);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, value, { mode: 0o600 });
    fs.renameSync(tmp, target);
    return "file";
  }

  async delete(key: string): Promise<void> {
    fs.rmSync(this.pathFor(key), { force: true });
  }
}

function psEncode(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

const DPAPI_SET = `$ErrorActionPreference='Stop'
$b64 = [Console]::In.ReadToEnd().Trim()
$plain = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
$sec = ConvertTo-SecureString -String $plain -AsPlainText -Force
[IO.File]::WriteAllText($env:KAI_SECRET_FILE, (ConvertFrom-SecureString -SecureString $sec))`;

const DPAPI_GET = `$ErrorActionPreference='Stop'
$enc = [IO.File]::ReadAllText($env:KAI_SECRET_FILE)
$sec = ConvertTo-SecureString -String $enc
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plain)))
} finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }`;

/** The inbox Windows PowerShell, by full path so a `powershell.exe` earlier on PATH cannot shadow it. */
const POWERSHELL = (() => {
  const root = process.env.SystemRoot ?? process.env.windir;
  const full = root && path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return full && fs.existsSync(full) ? full : "powershell.exe";
})();

/** Windows: the blob on disk is DPAPI-encrypted for this user and cannot be read by others. */
export class DpapiSecretStore implements SecretStore {
  private readonly blobs = new FileSecretStore("dpapi");
  constructor(private readonly run: Runner = runProcess) {}

  private blobPath(key: string): string {
    return path.join(credentialsDir(), `${fileNameFor(key)}.dpapi`);
  }

  /**
   * Windows PowerShell 5.1 started from PowerShell 7 (the default shell on CI runners and in many
   * terminals) inherits a PSModulePath that lists PS7's modules first. 5.1 then loads the wrong
   * `Microsoft.PowerShell.Security` and cannot find `ConvertTo-SecureString`. Dropping the variable
   * lets 5.1 rebuild its own default.
   */
  private psEnv(key: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, KAI_SECRET_FILE: this.blobPath(key) };
    for (const name of Object.keys(env))
      if (name.toLowerCase() === "psmodulepath") delete env[name];
    return env;
  }

  private psArgs(script: string): string[] {
    return [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      psEncode(script),
    ];
  }

  async get(key: string): Promise<string | null> {
    if (!(await this.has(key))) return null;
    const r = await this.run(POWERSHELL, this.psArgs(DPAPI_GET), { env: this.psEnv(key) });
    if (r.code !== 0 || !r.stdout.trim()) return null;
    return Buffer.from(r.stdout.trim(), "base64").toString("utf8");
  }

  has(key: string): Promise<boolean> {
    return this.blobs.has(key);
  }

  async set(key: string, value: string): Promise<SecretLocation> {
    fs.mkdirSync(credentialsDir(), { recursive: true, mode: 0o700 });
    const r = await this.run(POWERSHELL, this.psArgs(DPAPI_SET), {
      input: Buffer.from(value, "utf8").toString("base64"),
      env: this.psEnv(key),
    });
    if (r.code !== 0) {
      // Our own script text only: the secret travels on stdin and never appears in its output.
      const why = r.spawnError ?? (r.stderr.trim().split(/\r?\n/)[0] || `exit ${r.code}`);
      throw new Error(`DPAPI encryption failed: ${why}`);
    }
    return "os";
  }

  delete(key: string): Promise<void> {
    return this.blobs.delete(key);
  }
}

/** macOS login keychain. `security` only takes the secret as an argument, briefly visible to this user's `ps`. */
export class KeychainSecretStore implements SecretStore {
  constructor(private readonly run: Runner = runProcess) {}

  async get(key: string): Promise<string | null> {
    const r = await this.run("security", ["find-generic-password", "-a", "kai", "-s", key, "-w"]);
    return r.code === 0 ? r.stdout.replace(/\r?\n$/, "") : null;
  }

  async has(key: string): Promise<boolean> {
    const r = await this.run("security", ["find-generic-password", "-a", "kai", "-s", key]);
    return r.code === 0;
  }

  async set(key: string, value: string): Promise<SecretLocation> {
    const r = await this.run("security", [
      "add-generic-password",
      "-U",
      "-a",
      "kai",
      "-s",
      key,
      "-w",
      value,
    ]);
    if (r.code !== 0) throw new Error(r.spawnError ?? "keychain write failed");
    return "os";
  }

  async delete(key: string): Promise<void> {
    await this.run("security", ["delete-generic-password", "-a", "kai", "-s", key]);
  }
}

/** Linux Secret Service through `secret-tool`; the secret goes on stdin. */
export class SecretToolStore implements SecretStore {
  constructor(private readonly run: Runner = runProcess) {}

  private attrs(key: string): string[] {
    return ["service", "kai-terminal", "account", key];
  }

  async get(key: string): Promise<string | null> {
    const r = await this.run("secret-tool", ["lookup", ...this.attrs(key)]);
    return r.code === 0 && r.stdout ? r.stdout : null;
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async set(key: string, value: string): Promise<SecretLocation> {
    const r = await this.run(
      "secret-tool",
      ["store", "--label", "Kai Terminal", ...this.attrs(key)],
      {
        input: value,
      }
    );
    if (r.code !== 0) throw new Error(r.spawnError ?? "secret service write failed");
    return "os";
  }

  async delete(key: string): Promise<void> {
    await this.run("secret-tool", ["clear", ...this.attrs(key)]);
  }
}

/** Tries the OS store first; any failure falls through to the file store. */
export class CompositeSecretStore implements SecretStore {
  constructor(
    private readonly primary: SecretStore | null,
    private readonly file: SecretStore = new FileSecretStore()
  ) {}

  async get(key: string): Promise<string | null> {
    if (this.primary) {
      try {
        const v = await this.primary.get(key);
        if (v !== null) return v;
      } catch {
        // fall through to the file
      }
    }
    return this.file.get(key);
  }

  async has(key: string): Promise<boolean> {
    if (this.primary) {
      try {
        if (await this.primary.has(key)) return true;
      } catch {
        // fall through to the file
      }
    }
    return this.file.has(key);
  }

  async set(key: string, value: string): Promise<SecretLocation> {
    if (this.primary) {
      try {
        const where = await this.primary.set(key, value);
        // A leftover file copy would outlive a later sign-out of the OS copy.
        await this.file.delete(key);
        return where;
      } catch {
        // OS store unavailable: keep the secret usable, but say where it went.
      }
    }
    return this.file.set(key, value);
  }

  async delete(key: string): Promise<void> {
    const results = await Promise.allSettled([
      this.primary ? this.primary.delete(key) : Promise.resolve(),
      this.file.delete(key),
    ]);
    const failed = results.find((r) => r.status === "rejected");
    if (failed && failed.status === "rejected") throw failed.reason;
  }
}

let cached: SecretStore | null = null;

/** The store for this machine. Chosen once per process. */
export function defaultSecretStore(platform: NodeJS.Platform = process.platform): SecretStore {
  if (cached && platform === process.platform) return cached;
  let primary: SecretStore | null = null;
  if (platform === "win32") primary = new DpapiSecretStore();
  else if (platform === "darwin") primary = new KeychainSecretStore();
  else if (platform === "linux") primary = new SecretToolStore();
  const store = new CompositeSecretStore(primary);
  if (platform === process.platform) cached = store;
  return store;
}

/** Test seam: forget the cached store. */
export function resetDefaultSecretStore(): void {
  cached = null;
}

/** `kai/<provider>/<account>`: the key an account's secret is stored under. */
export function secretKeyFor(accountId: string): string {
  return `kai/${accountId.replace(":", "/")}`;
}
