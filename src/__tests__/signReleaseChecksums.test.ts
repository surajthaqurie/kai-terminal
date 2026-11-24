import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The UPDATE_SIGNING_KEY secret, as the release's signing step reads it
 * (scripts/sign-release-checksums.sh). Every key here is a throwaway generated for the test in a
 * temporary folder and deleted afterwards; the real key is never needed or touched.
 *
 * Runs where a bash with an OpenSSL that can make Ed25519 keys exists (Linux CI, Windows with Git
 * Bash). The real signing step runs on the Ubuntu publish job.
 */
const repo = resolve(__dirname, "../..");
const script = join(repo, "scripts/sign-release-checksums.sh");
const embeddedPublicKey = join(repo, "src-tauri/update-public-key.hex");

function findBash(): string | null {
  if (process.platform === "win32") {
    // Plain `bash` on Windows is usually WSL's launcher; the script needs Git Bash's tools.
    const git = "C:\\Program Files\\Git\\bin\\bash.exe";
    return existsSync(git) ? git : null;
  }
  return "bash";
}

const bash = findBash();
const run = (cmd: string, env: Record<string, string | undefined> = {}) =>
  spawnSync(bash!, ["-c", cmd], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"], // no terminal: a passphrase prompt must fail, not hang
    timeout: 30_000,
  });
const usable = bash !== null && run("openssl genpkey -algorithm ED25519 >/dev/null").status === 0;

const work = mkdtempSync(join(tmpdir(), "kai-sign-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const posix = (p: string) =>
  process.platform === "win32"
    ? p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, "/")
    : p;

/** A fresh Ed25519 key pair: PKCS#8 PEM text and the public key as the app stores it. */
function keyPair(name: string): { pem: string; publicHex: string; publicFile: string } {
  const pemFile = join(work, `${name}.pem`);
  const publicFile = join(work, `${name}.hex`);
  const r = run(
    `openssl genpkey -algorithm ED25519 -out '${posix(pemFile)}' && ` +
      `openssl pkey -in '${posix(pemFile)}' -pubout -outform DER | tail -c 32 | od -An -tx1 | tr -d ' \\n' > '${posix(publicFile)}'`
  );
  expect(r.status, r.stderr).toBe(0);
  return {
    pem: readFileSync(pemFile, "utf8"),
    publicHex: readFileSync(publicFile, "utf8").trim(),
    publicFile,
  };
}

/** A release folder with one installer, and an output folder per run. */
function release(name: string): { artifacts: string; out: string } {
  const artifacts = join(work, `${name}-artifacts`);
  mkdirSync(join(artifacts, "nsis"), { recursive: true });
  writeFileSync(join(artifacts, "nsis", "kai_9.9.9_x64-setup.exe"), "installer bytes");
  return { artifacts, out: join(work, `${name}-out`) };
}

function sign(key: string | undefined, name: string, publicFile = embeddedPublicKey) {
  const { artifacts, out } = release(name);
  const r = run(
    `bash '${posix(script)}' '${posix(artifacts)}' '${posix(out)}' '${posix(publicFile)}'`,
    {
      UPDATE_SIGNING_KEY: key,
    }
  );
  return { ...r, out };
}

describe.skipIf(!usable)("UPDATE_SIGNING_KEY format (sign-release-checksums.sh)", () => {
  it("a correct Ed25519 PKCS#8 PEM key signs SHA256SUMS with a 64-byte signature that verifies", () => {
    const k = keyPair("good");
    const r = sign(k.pem, "good", k.publicFile);
    expect(r.status, r.stderr).toBe(0);
    const sums = readFileSync(join(r.out, "SHA256SUMS"), "utf8");
    // sha256sum writes "<hash>  <name>" (Ubuntu, where the release signs) or "<hash> *<name>"
    // (binary mode, Git Bash); the app accepts both.
    expect(sums).toMatch(/^[0-9a-f]{64} [ *]kai_9\.9\.9_x64-setup\.exe\n$/);
    expect(readFileSync(join(r.out, "SHA256SUMS.sig")).length).toBe(64);
    expect(r.stdout).toContain(k.publicHex); // the log names the public half only
    expect(r.stdout).not.toContain("PRIVATE KEY");
  });

  it("without the secret the release is published unsigned: a warning, exit 0, nothing written", () => {
    const r = sign(undefined, "none");
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toContain("UPDATE_SIGNING_KEY is not set");
    expect(existsSync(join(r.out, "SHA256SUMS"))).toBe(false);
  });

  it("a key that does not match the public key compiled into the app fails and leaves nothing", () => {
    const r = sign(keyPair("other").pem, "mismatch", embeddedPublicKey);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("does not match src-tauri/update-public-key.hex");
    expect(existsSync(join(r.out, "SHA256SUMS.sig"))).toBe(false);
    expect(r.stderr).not.toContain("PRIVATE KEY");
  });

  it("a PEM pasted as one line (line breaks lost) is refused", () => {
    const k = keyPair("oneline");
    const r = sign(k.pem.replace(/\r?\n/g, " "), "oneline", k.publicFile);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("lost its line breaks");
    expect(existsSync(join(r.out, "SHA256SUMS.sig"))).toBe(false);
  });

  it("a passphrase-protected key is refused (CI cannot type a passphrase)", () => {
    const k = keyPair("encrypted");
    const encFile = join(work, "encrypted.enc.pem");
    const e = run(
      `openssl pkcs8 -topk8 -v2 aes-256-cbc -passout pass:test-only -in '${posix(join(work, "encrypted.pem"))}' -out '${posix(encFile)}'`
    );
    expect(e.status, e.stderr).toBe(0);
    const r = sign(readFileSync(encFile, "utf8"), "encrypted", k.publicFile);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("passphrase-protected");
    expect(existsSync(join(r.out, "SHA256SUMS.sig"))).toBe(false);
  });

  it("a PEM with Windows line endings (pasted from a Windows editor) still signs", () => {
    const k = keyPair("crlf");
    const r = sign(k.pem.replace(/\r?\n/g, "\r\n"), "crlf", k.publicFile);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(r.out, "SHA256SUMS.sig")).length).toBe(64);
  });

  it("an OpenSSH key is refused with the format it needs", () => {
    const r = sign(
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
      "openssh"
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("OpenSSH key");
  });

  it("something that is not a PEM key (a hex seed, a public key) is refused", () => {
    for (const [name, value] of [
      ["hex", "a".repeat(64)],
      ["public", "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----\n"],
    ]) {
      const r = sign(value, `notpem-${name}`);
      expect(r.status, name).not.toBe(0);
      expect(r.stderr, name).toContain("not a PKCS#8 PEM private key");
    }
  });
});
