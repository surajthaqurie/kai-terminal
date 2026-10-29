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

const DPAPI_V2 = "dpapi2:";

function psEncode(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * Straight .NET calls, no cmdlets: nothing to autoload, so a PowerShell 7 `PSModulePath` inherited
 * from the parent shell (CI runners, many terminals) cannot break Windows PowerShell 5.1 here.
 * The secret arrives in the child's environment, never in argv, and the child's output only ever
 * carries the plaintext of a `get`.
 */
const DPAPI_PREAMBLE = `$ErrorActionPreference='Stop'
[void][Reflection.Assembly]::LoadWithPartialName('System.Security')
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser`;

const DPAPI_SET = `${DPAPI_PREAMBLE}
$plain = [Convert]::FromBase64String($env:KAI_SECRET_B64)
$enc = [Security.Cryptography.ProtectedData]::Protect($plain, $null, $scope)
[IO.File]::WriteAllText($env:KAI_SECRET_FILE, '${DPAPI_V2}' + [Convert]::ToBase64String($enc))`;

const DPAPI_GET = `${DPAPI_PREAMBLE}
$raw = [IO.File]::ReadAllText($env:KAI_SECRET_FILE).Trim()
$enc = [Convert]::FromBase64String($raw.Substring('${DPAPI_V2}'.Length))
$plain = [Security.Cryptography.ProtectedData]::Unprotect($enc, $null, $scope)
[Console]::Out.Write([Convert]::ToBase64String($plain))`;

/**
 * Blobs written by 0.2.1 (`ConvertFrom-SecureString` without a key: the hex of a plain DPAPI blob over
 * the UTF-16 text). Still readable; rewritten on the next sign-in. Decoded through .NET like the v2
 * path, because autoloading `ConvertTo-SecureString` is slow enough to hit the timeout on cold runners.
 * Any cmdlet (even `New-Object`) triggers that same module autoload, so this script uses none.
 */
const DPAPI_GET_LEGACY = `${DPAPI_PREAMBLE}
$hex = [IO.File]::ReadAllText($env:KAI_SECRET_FILE).Trim()
$enc = [byte[]]::new([int]($hex.Length / 2))
for ($i = 0; $i -lt $enc.Length; $i++) { $enc[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }
$plain = [Security.Cryptography.ProtectedData]::Unprotect($enc, $null, $scope)
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::Convert([Text.Encoding]::Unicode, [Text.Encoding]::UTF8, $plain)))`;

/** The inbox Windows PowerShell, by full path so a `powershell.exe` earlier on PATH cannot shadow it. */
const POWERSHELL = (() => {
  const root = process.env.SystemRoot ?? process.env.windir;
  const full = root && path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return full && fs.existsSync(full) ? full : "powershell.exe";
})();

/** Windows PowerShell can take a few seconds to start cold; a hung one must not stall a sign-in. */
const DPAPI_TIMEOUT_MS = 15_000;

/**
 * The child environment for Windows PowerShell 5.1, minus any inherited `PSModulePath`. A PowerShell 7
 * parent points it at 7-only modules, so 5.1 cannot autoload cmdlets and exits non-zero; unset, it
 * falls back to its own defaults.
 */
export function windowsPowerShellEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toLowerCase() !== "psmodulepath") env[k] = v;
  }
  return { ...env, ...extra };
}

/** Windows: the blob on disk is DPAPI-encrypted for this user and cannot be read by others. */
export class DpapiSecretStore implements SecretStore {
  private readonly blobs = new FileSecretStore("dpapi");
  constructor(private readonly run: Runner = runProcess) {}

  private blobPath(key: string): string {
    return path.join(credentialsDir(), `${fileNameFor(key)}.dpapi`);
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
    const blob = await this.blobs.get(key);
    if (blob === null) return null;
    const script = blob.startsWith(DPAPI_V2) ? DPAPI_GET : DPAPI_GET_LEGACY;
    const r = await this.run(POWERSHELL, this.psArgs(script), {
      env: windowsPowerShellEnv({ KAI_SECRET_FILE: this.blobPath(key) }),
      timeoutMs: DPAPI_TIMEOUT_MS,
    });
    if (r.code !== 0 || !r.stdout.trim()) return null;
    return Buffer.from(r.stdout.trim(), "base64").toString("utf8");
  }

  has(key: string): Promise<boolean> {
    return this.blobs.has(key);
  }

  async set(key: string, value: string): Promise<SecretLocation> {
    fs.mkdirSync(credentialsDir(), { recursive: true, mode: 0o700 });
    const r = await this.run(POWERSHELL, this.psArgs(DPAPI_SET), {
      env: windowsPowerShellEnv({
        KAI_SECRET_FILE: this.blobPath(key),
        KAI_SECRET_B64: Buffer.from(value, "utf8").toString("base64"),
      }),
      timeoutMs: DPAPI_TIMEOUT_MS,
    });
    if (r.code !== 0) {
      // PowerShell's own message about our script; it never echoes the secret.
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
