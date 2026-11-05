import { describe, expect, it, vi } from "vitest";
import { createHiddenGpuBudget } from "../components/gpuBudget";

describe("createHiddenGpuBudget", () => {
  it("keeps hidden panes' renderers while within the budget", () => {
    const budget = createHiddenGpuBudget(2);
    const a = vi.fn();
    const b = vi.fn();
    budget.hide(a);
    budget.hide(b);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(budget.size).toBe(2);
  });

  it("releases the longest-hidden pane first once over budget", () => {
    const budget = createHiddenGpuBudget(2);
    const [a, b, c] = [vi.fn(), vi.fn(), vi.fn()];
    budget.hide(a);
    budget.hide(b);
    budget.hide(c);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    expect(c).not.toHaveBeenCalled();
    expect(budget.size).toBe(2);
  });

  it("a re-shown pane stops counting and is never released", () => {
    const budget = createHiddenGpuBudget(1);
    const [a, b] = [vi.fn(), vi.fn()];
    budget.hide(a);
    budget.show(a);
    budget.hide(b);
    expect(a).not.toHaveBeenCalled();
    expect(budget.size).toBe(1);
  });

  it("hiding the same pane twice counts it once", () => {
    const budget = createHiddenGpuBudget(1);
    const a = vi.fn();
    budget.hide(a);
    budget.hide(a);
    expect(a).not.toHaveBeenCalled();
    expect(budget.size).toBe(1);
  });

  it("survives a release that throws", () => {
    const budget = createHiddenGpuBudget(1);
    const bad = vi.fn(() => {
      throw new Error("disposed");
    });
    const next = vi.fn();
    budget.hide(bad);
    expect(() => budget.hide(next)).not.toThrow();
    expect(budget.size).toBe(1);
  });
});
