import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * CI-03: every file a release ships gets a signed build-provenance attestation, so a download can
 * be traced to this workflow and commit (`gh attestation verify`). Read as text: the workflow has
 * no YAML parser among the dependencies, and the blocks checked here are plain literal lists.
 */
const release = fs.readFileSync(
  path.resolve(__dirname, "../../.github/workflows/release.yml"),
  "utf8"
);
const lines = release.split(/\r?\n/);

/** The lines of the `key: |` literal block that follows `after` (first match). */
function literalBlock(key: string, after: string): string[] {
  const start = lines.findIndex((l) => l.includes(after));
  const keyAt = lines.findIndex((l, i) => i > start && l.trim() === `${key}: |`);
  expect(start, after).toBeGreaterThan(-1);
  expect(keyAt, key).toBeGreaterThan(-1);
  const indent = lines[keyAt].search(/\S/);
  const out: string[] = [];
  for (const line of lines.slice(keyAt + 1)) {
    if (line.trim() === "" || line.search(/\S/) <= indent) break;
    if (!line.trim().startsWith("#")) out.push(line.trim());
  }
  return out;
}

/** The `publish` job's text. */
const publish = release.slice(release.indexOf("\n  publish:"));

describe("release build provenance", () => {
  it("the publish job may request an OIDC token and write attestations, and still write contents", () => {
    const perms = publish.slice(0, publish.indexOf("steps:"));
    expect(perms).toMatch(/id-token:\s*write/);
    expect(perms).toMatch(/attestations:\s*write/);
    expect(perms).toMatch(/contents:\s*write/); // job permissions replace the workflow's
  });

  it("attests exactly the files the release uploads (signatures of the checksums aside)", () => {
    const attested = literalBlock("subject-path", "Attest build provenance");
    const uploaded = literalBlock("files", "Create GitHub Release").filter(
      (f) => !f.startsWith("release-signing/")
    );
    expect(attested.length).toBeGreaterThan(0);
    expect([...attested].sort()).toEqual([...uploaded].sort());
  });

  it("attests after the files are renamed and version-checked, before anything is uploaded", () => {
    const at = (name: string) => publish.indexOf(`name: ${name}`);
    expect(at("Verify every file belongs to this tag's version")).toBeGreaterThan(-1);
    expect(at("Attest build provenance of the release files")).toBeGreaterThan(
      at("Verify every file belongs to this tag's version")
    );
    expect(at("Attest build provenance of the release files")).toBeLessThan(
      at("Create GitHub Release with verified artifacts")
    );
  });
});
