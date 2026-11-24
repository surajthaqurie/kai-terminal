import path from "path";
import { pathToFileURL } from "url";
import { describe, expect, it } from "vitest";

/** RES-04: the CI gate that stops the frontend from silently growing. */
type Asset = { name: string; kb: number };
type Budget = { entries?: Record<string, number>; totalJs?: number; totalCss?: number };
const load = async () =>
  (await import(
    pathToFileURL(path.resolve(__dirname, "../../scripts/check-bundle-budget.mjs")).href
  )) as {
    checkBudget(a: Asset[], b: Budget): { rows: unknown[]; failures: string[] };
  };

const assets: Asset[] = [
  { name: "App-AbC123.js", kb: 190 },
  { name: "index-XyZ789.js", kb: 70 },
  { name: "MusicPanel-q1.js", kb: 12 },
  { name: "index-Hh.css", kb: 20 },
];

describe("bundle budget", () => {
  it("passes when every limit holds", async () => {
    const { checkBudget } = await load();
    const r = checkBudget(assets, { entries: { App: 208, index: 78 }, totalJs: 300, totalCss: 25 });
    expect(r.failures).toEqual([]);
  });

  it("fails an entry chunk that outgrows its limit, naming it", async () => {
    const { checkBudget } = await load();
    const r = checkBudget(assets, { entries: { App: 150 } });
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatch(/App-AbC123\.js.*190\.0 kB.*150/);
  });

  it("fails on the totals, so a new chunk cannot dodge the per-entry limits", async () => {
    const { checkBudget } = await load();
    expect(checkBudget(assets, { totalJs: 200 }).failures[0]).toMatch(/all JavaScript/);
    expect(checkBudget(assets, { totalCss: 10 }).failures[0]).toMatch(/all CSS/);
  });

  it("fails loudly when a budgeted chunk no longer exists instead of passing vacuously", async () => {
    const { checkBudget } = await load();
    expect(checkBudget(assets, { entries: { Gone: 10 } }).failures[0]).toMatch(/no built chunk/);
  });
});
