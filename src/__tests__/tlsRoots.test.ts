import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * RES-09: the Rust side's HTTPS (update download, YouTube search) must trust the certificates in
 * the OS store, or it fails behind a company proxy that inspects TLS with its own CA while the
 * webview, which uses the OS store, works. The bundled Mozilla roots stay as a fallback for
 * systems whose store cannot be read. Update integrity does not rest on TLS: the downloaded
 * checksums are verified against an Ed25519 signature before anything runs (SEC-02).
 */
describe("Rust HTTPS client trust roots", () => {
  const cargo = fs.readFileSync(path.resolve(__dirname, "../../src-tauri/Cargo.toml"), "utf8");
  const line = cargo.split(/\r?\n/).find((l) => /^reqwest\s*=/.test(l)) ?? "";
  const features = [
    ...(/features\s*=\s*\[([^\]]*)\]/.exec(line)?.[1] ?? "").matchAll(/"([^"]+)"/g),
  ].map((m) => m[1]);

  it("trusts the OS certificate store", () => {
    expect(features).toContain("rustls-tls-native-roots");
  });

  it("keeps the bundled roots as a fallback", () => {
    expect(features).toContain("rustls-tls");
  });

  it("stays on rustls (no OpenSSL / platform TLS library to ship or link)", () => {
    expect(line).toMatch(/default-features\s*=\s*false/);
    expect(features).not.toContain("native-tls");
    expect(features).not.toContain("default-tls");
  });
});
