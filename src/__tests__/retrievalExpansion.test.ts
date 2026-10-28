import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { registerProject } from "../core/registry";
import { indexProject } from "../core/indexer";
import {
  rankCandidates,
  retrieveContext,
  ANCHORED_MIN_SCORE_RATIO,
  MAX_EXPANDED_CALLERS,
  MAX_EXPANDED_TESTS,
  MAX_EXAMINED_IMPORTERS,
} from "../core/retrieval";
import { assembleContext } from "../core/contextAssembler";
import { classifyTask } from "../core/classifier";
import type { ProjectIndex } from "../core/types";

let home = "";
let root = "";
const prevHome = process.env.KAI_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-exp-home-"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-exp-proj-"));
  process.env.KAI_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.KAI_HOME;
  else process.env.KAI_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
async function build(): Promise<ProjectIndex> {
  return indexProject(registerProject(root));
}

/** `cancelOrder` is defined in a service; a route file named `orders.ts` merely handles it. */
function writeOrderProject(): void {
  write(
    "src/services/orderService.ts",
    [
      'import { saveOrder } from "../models/order";',
      "export function cancelOrder(id: string) {",
      "  return saveOrder({ id, status: 'cancelled' });",
      "}",
    ].join("\n")
  );
  write("src/models/order.ts", "export function saveOrder(o: object) { return o; }\n");
  write(
    "src/routes/orders.ts",
    [
      'import { cancelOrder } from "../services/orderService";',
      "export function cancelOrderHandler(id: string) { return cancelOrder(id); }",
      "export function createOrderHandler() { return 1; }",
      "export function getOrderHandler() { return 2; }",
      "export function listOrderHandler() { return 3; }",
    ].join("\n")
  );
}

describe("anchoring on an identifier typed in full", () => {
  it("ranks the file that defines the named symbol above a file named after its words", async () => {
    writeOrderProject();
    const index = await build();
    const ranking = rankCandidates(index, "explain how cancelOrder works");
    expect(ranking.ranked[0].file.relativePath).toBe("src/services/orderService.ts");
    expect(ranking.anchor).toEqual({
      name: "cancelOrder",
      filePath: "src/services/orderService.ts",
    });
  });

  it("does not anchor on a plain word that merely equals a symbol name", async () => {
    write("src/models/order.ts", "export interface Order { id: string }\n");
    write("src/other.ts", "export function noop() { return 1; }\n");
    const index = await build();
    const ranking = rankCandidates(index, "add a field to the order model");
    expect(ranking.anchor).toBeUndefined();
  });

  it("keeps full path credit for a word the user typed on its own", async () => {
    writeOrderProject();
    const index = await build();
    const anchoredOnly = rankCandidates(index, "cancelOrder");
    const withWord = rankCandidates(index, "cancelOrder orders");
    const scoreOf = (r: typeof anchoredOnly, rel: string) =>
      r.ranked.find((x) => x.file.relativePath === rel)?.score ?? 0;
    // `orders` typed standalone matches routes/orders.ts at full weight.
    expect(scoreOf(withWord, "src/routes/orders.ts")).toBeGreaterThan(
      scoreOf(anchoredOnly, "src/routes/orders.ts")
    );
  });

  it("still finds a file that matches only on the split words (reduced, not erased)", async () => {
    write("src/service.ts", "export class AuthService { login() { return true; } }");
    write(
      "tests/service.test.ts",
      "import { AuthService } from '../src/service'; describe('AuthService', () => {});"
    );
    const index = await build();
    const r = retrieveContext(index, "write unit tests for AuthService", { includeTests: true });
    expect(r.matchedFiles.some((f) => f.file.relativePath === "tests/service.test.ts")).toBe(true);
  });
});

describe("anchored relevance floor", () => {
  async function noisyProject(): Promise<ProjectIndex> {
    write(
      "src/report.ts",
      "export function computeQuarterlyTotals(rows: number[]) {\n  return rows.length;\n}\n"
    );
    for (let i = 0; i < 4; i++) {
      write(
        `src/f${i}.ts`,
        `export function computeFeature${i}Total(x: number) {\n  return x * ${i};\n}\n`
      );
    }
    return build();
  }

  it("drops files that match only on split words once the query is anchored", async () => {
    const index = await noisyProject();
    const r = retrieveContext(index, "fix computeQuarterlyTotals", {
      minScoreRatio: 0.25,
      fileBudget: 10,
    });
    expect(r.matchedFiles.map((f) => f.file.relativePath)).toEqual(["src/report.ts"]);
    expect(r.omissions.some((o) => o.reason === "low_relevance")).toBe(true);
    expect(ANCHORED_MIN_SCORE_RATIO).toBeGreaterThan(0.25);
  });

  it("leaves the floor alone when the caller did not opt into early stopping", async () => {
    const index = await noisyProject();
    const r = retrieveContext(index, "fix computeQuarterlyTotals", { fileBudget: 10 });
    expect(r.matchedFiles.length).toBeGreaterThan(1);
  });
});

/** formatMoney is defined once; `callers` files import it, `bystanders` import the file but never use it. */
function writeCallerProject(callers: number, bystanders = 0, tests = 0): void {
  write("src/utils/money.ts", "export function formatMoney(c: number) {\n  return c / 100;\n}\n");
  for (let i = 0; i < callers; i++) {
    write(
      `src/users/u${String(i).padStart(2, "0")}.ts`,
      [
        'import { formatMoney } from "../utils/money";',
        `export function show${i}(c: number) {`,
        "  return formatMoney(c);",
        "}",
      ].join("\n")
    );
  }
  for (let i = 0; i < bystanders; i++) {
    write(
      `src/bystanders/b${i}.ts`,
      `import * as money from "../utils/money";\nexport const keep${i} = money;\n`
    );
  }
  for (let i = 0; i < tests; i++) {
    write(
      `src/__tests__/money${i}.test.ts`,
      `import { formatMoney } from "../utils/money";\ndescribe("m${i}", () => { it("x", () => formatMoney(1)); });\n`
    );
  }
}

describe("bounded neighbour expansion", () => {
  const expandAll = { callers: true, tests: true };

  it("adds callers of the anchored symbol after the ranked files, labelled and unscored", async () => {
    writeCallerProject(3);
    const index = await build();
    const r = retrieveContext(index, "rename formatMoney to formatCurrency", {
      expand: expandAll,
      tokenBudget: 4000,
    });
    const files = r.matchedFiles.map((f) => f.file.relativePath);
    expect(files[0]).toBe("src/utils/money.ts");
    expect(files).toEqual(
      expect.arrayContaining(["src/users/u00.ts", "src/users/u01.ts", "src/users/u02.ts"])
    );
    const caller = r.matchedFiles.find((f) => f.file.relativePath === "src/users/u00.ts")!;
    expect(caller.relation).toBe("caller of formatMoney (src/utils/money.ts)");
    expect(caller.score).toBe(0);
    expect(caller.snippet).toContain("formatMoney(c)");
    // the excerpt is the usage, not the whole file head
    expect(caller.startLine).toBeGreaterThanOrEqual(1);
  });

  it("does nothing unless asked", async () => {
    writeCallerProject(3);
    const index = await build();
    const r = retrieveContext(index, "rename formatMoney to formatCurrency", { tokenBudget: 4000 });
    expect(r.matchedFiles.map((f) => f.file.relativePath)).toEqual(["src/utils/money.ts"]);
  });

  it("does nothing without an anchored identifier", async () => {
    writeCallerProject(3);
    const index = await build();
    const r = retrieveContext(index, "money", { expand: expandAll, tokenBudget: 4000 });
    expect(r.matchedFiles.every((f) => f.relation === undefined)).toBe(true);
  });

  it("skips importers that never mention the symbol", async () => {
    writeCallerProject(1, 2);
    const index = await build();
    const r = retrieveContext(index, "rename formatMoney to formatCurrency", {
      expand: expandAll,
      tokenBudget: 4000,
    });
    const files = r.matchedFiles.map((f) => f.file.relativePath);
    expect(files).toContain("src/users/u00.ts");
    expect(files.some((f) => f.startsWith("src/bystanders/"))).toBe(false);
  });

  it("caps callers and reports every one it did not deliver", async () => {
    writeCallerProject(MAX_EXPANDED_CALLERS + 3);
    const index = await build();
    const r = retrieveContext(index, "rename formatMoney to formatCurrency", {
      expand: { callers: true },
      tokenBudget: 8000,
    });
    const delivered = r.matchedFiles.filter((f) => f.relation?.startsWith("caller"));
    expect(delivered).toHaveLength(MAX_EXPANDED_CALLERS);
    const summary = r.omissions.filter((o) => o.identifier.includes("more importer(s)"));
    expect(summary).toHaveLength(1);
    expect(summary[0].identifier).toContain("3 more importer(s) of src/utils/money.ts");
    expect(summary[0].reason).toBe("budget_exceeded");
  });

  it("bounds how many importers it reads and says so", async () => {
    // 'a*' bystanders sort before the one real caller 'z', which is past the examined limit.
    write("src/utils/money.ts", "export function formatMoney(c: number) { return c; }\n");
    for (let i = 0; i < MAX_EXAMINED_IMPORTERS + 5; i++) {
      write(
        `src/a${String(i).padStart(3, "0")}.ts`,
        `import * as m from "./utils/money";\nexport const k${i} = m;\n`
      );
    }
    write(
      "src/z.ts",
      'import { formatMoney } from "./utils/money";\nexport const z = formatMoney(1);\n'
    );
    const index = await build();
    const r = retrieveContext(index, "rename formatMoney to formatCurrency", {
      expand: { callers: true },
      tokenBudget: 4000,
    });
    expect(r.matchedFiles.some((f) => f.relation)).toBe(false);
    expect(r.omissions.some((o) => o.identifier.includes("more importer(s)"))).toBe(true);
  });

  it("caps tests, and tests are optional independently of callers", async () => {
    writeCallerProject(1, 0, MAX_EXPANDED_TESTS + 2);
    const index = await build();
    const testsOnly = retrieveContext(index, "rename formatMoney to formatCurrency", {
      expand: { tests: true },
      includeTests: false, // as the assembler does outside test/debug tasks
      tokenBudget: 8000,
    });
    const rels = testsOnly.matchedFiles.map((f) => f.relation ?? "");
    expect(rels.filter((x) => x.startsWith("test importing"))).toHaveLength(MAX_EXPANDED_TESTS);
    expect(rels.some((x) => x.startsWith("caller"))).toBe(false);
  });

  it("stops at the token budget and says what it left out", async () => {
    writeCallerProject(6);
    const index = await build();
    const r = retrieveContext(index, "rename formatMoney to formatCurrency", {
      expand: { callers: true },
      tokenBudget: 200, // clamp floor: room for the anchor file, not for every caller
    });
    expect(r.usedTokens).toBeLessThanOrEqual(200);
    const delivered = r.matchedFiles.filter((f) => f.relation).length;
    // One neighbour that did not fit is named, the rest are counted in a summary entry.
    const named = r.omissions.filter((o) => o.identifier.startsWith("src/users/")).length;
    const summary = r.omissions.find((o) => o.identifier.includes("more importer(s)"));
    const counted = summary ? Number(/^([0-9]+) more/.exec(summary.identifier)?.[1]) : 0;
    expect(delivered + named + counted).toBe(6);
    expect(delivered).toBeLessThan(6);
  });

  it("never delivers a caller whose content now looks like a credential", async () => {
    writeCallerProject(2);
    const index = await build();
    // Edited after indexing: the cached index still lists the file as a caller.
    write(
      "src/users/u00.ts",
      `import { formatMoney } from "../utils/money";\nexport const k = "AKIA${"A".repeat(16)}"; formatMoney(1);\n`
    );
    const r = retrieveContext(index, "rename formatMoney to formatCurrency", {
      expand: expandAll,
      tokenBudget: 4000,
    });
    expect(r.matchedFiles.some((f) => f.file.relativePath === "src/users/u00.ts")).toBe(false);
    expect(
      r.omissions.some((o) => o.identifier === "src/users/u00.ts" && o.reason === "untrusted")
    ).toBe(true);
  });

  it("reports a caller deleted since indexing as stale instead of failing", async () => {
    writeCallerProject(2);
    const index = await build();
    fs.rmSync(path.join(root, "src/users/u01.ts"));
    const r = retrieveContext(index, "rename formatMoney to formatCurrency", {
      expand: expandAll,
      tokenBudget: 4000,
    });
    expect(r.staleFiles).toContain("src/users/u01.ts");
    expect(r.matchedFiles.some((f) => f.file.relativePath === "src/users/u00.ts")).toBe(true);
  });

  it("is deterministic", async () => {
    writeCallerProject(5, 1, 1);
    const index = await build();
    const run = () =>
      JSON.stringify(
        retrieveContext(index, "rename formatMoney to formatCurrency", {
          expand: expandAll,
          tokenBudget: 4000,
        }).matchedFiles.map((f) => [f.file.relativePath, f.startLine, f.endLine, f.relation])
      );
    expect(run()).toBe(run());
  });
});

describe("expansion through assembleContext", () => {
  it("classifies 'rename X to Y' as a refactor", () => {
    expect(
      classifyTask("rename formatMoney to formatCurrency everywhere it is used").category
    ).toBe("refactor");
  });

  it("adds callers for a default-budget refactor and renders the relation, not a score", async () => {
    writeCallerProject(3);
    const index = await build();
    const { contextPackage, renderedPrompt } = assembleContext(index, {
      task: "rename formatMoney to formatCurrency everywhere it is used",
      adaptiveBudget: true,
    });
    const rels = contextPackage.sourceReferences.map((s) => s.relation).filter(Boolean);
    expect(rels).toHaveLength(3);
    expect(renderedPrompt).toContain("[caller of formatMoney (src/utils/money.ts)]");
  });

  it("keeps the plain ranked list when the caller sets an explicit tokenBudget", async () => {
    writeCallerProject(3);
    const index = await build();
    const { contextPackage } = assembleContext(index, {
      task: "rename formatMoney to formatCurrency everywhere it is used",
      adaptiveBudget: true,
      tokenBudget: 4000,
    });
    expect(contextPackage.sourceReferences.some((s) => s.relation)).toBe(false);
  });

  it("does not expand for an explanation task", async () => {
    writeCallerProject(3);
    const index = await build();
    const { contextPackage } = assembleContext(index, {
      task: "explain how formatMoney works",
      adaptiveBudget: true,
    });
    expect(contextPackage.sourceReferences.some((s) => s.relation)).toBe(false);
  });
});
