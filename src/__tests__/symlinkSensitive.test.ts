import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexProject, targetIsSensitive } from "../core/indexer";
import { registerProject } from "../core/registry";
import { callTool } from "./helpers/mcpCall";
import { symlinkOrSkip } from "./helpers/symlink";

/**
 * SEC-05: the sensitive-file filter looked at the name of the directory entry only, so a link
 * inside the project named `notes.txt` that points at `.env` / `id_rsa` was indexed and could be
 * read through the MCP tools. What the link resolves to is now checked as well.
 *
 * File links need Developer Mode (or elevation) on Windows; Linux and macOS CI always run them.
 */
let home = "";
let root = "";
const savedHome = process.env.KAI_HOME;
const SECRET_LINE = "DB_PASSWORD=correct horse battery staple";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-symsens-home-"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-symsens-proj-"));
  process.env.KAI_HOME = home;
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, ".env"), SECRET_LINE + "\n");
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.KAI_HOME;
  else process.env.KAI_HOME = savedHome;
  for (const d of [home, root]) fs.rmSync(d, { recursive: true, force: true });
});

describe("targetIsSensitive", () => {
  it("judges the resolved file's name, whatever the link was called", () => {
    for (const real of [
      "/p/.env",
      "/p/.env.production",
      "/home/u/.ssh/id_rsa",
      path.join("C:", "p", ".env"),
    ]) {
      expect(targetIsSensitive(real), real).toBe(true);
    }
    for (const real of ["/p/src/a.ts", "/p/README.md", path.join("C:", "p", "notes.txt")]) {
      expect(targetIsSensitive(real), real).toBe(false);
    }
  });
});

describe("a link to a credential file", () => {
  it("is not indexed and cannot be read through the MCP tools", async (ctx) => {
    symlinkOrSkip(ctx, path.join(root, ".env"), path.join(root, "notes.txt"), "file");
    const meta = registerProject(root);
    const index = await indexProject(meta, { forceRebuild: true });
    expect(Object.keys(index.files)).not.toContain("notes.txt");

    const read = await callTool(root, "kai_read_range", {
      filePath: "notes.txt",
      startLine: 1,
      endLine: 5,
    });
    expect(JSON.stringify(read)).not.toContain("correct horse");
    expect(read.error !== undefined || read.json === null || read.json?.error !== undefined).toBe(
      true
    );
  });

  it("a link to an ordinary file is still indexed and readable", async (ctx) => {
    symlinkOrSkip(ctx, path.join(root, "src", "a.ts"), path.join(root, "alias.ts"), "file");
    const meta = registerProject(root);
    await indexProject(meta, { forceRebuild: true });
    const read = await callTool(root, "kai_read_range", {
      filePath: "alias.ts",
      startLine: 1,
      endLine: 1,
    });
    expect(JSON.stringify(read)).toContain("export const a");
  });
});
