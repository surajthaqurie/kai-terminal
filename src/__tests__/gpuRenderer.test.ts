// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The WebGL renderer attach / detach rules, tested on their own now that they are not part of the
 * terminal component (ARCH-03): a failure is never fatal, a lost context falls back to the DOM
 * renderer and repaints, and `localStorage.kai_renderer = "dom"` switches the GPU off.
 */
const hoisted = vi.hoisted(() => {
  const state = { created: [] as unknown[], failConstruct: false };
  class FakeAddon {
    disposed = 0;
    private lossHandler: (() => void) | undefined;
    constructor() {
      if (state.failConstruct) throw new Error("WebGL2 unavailable");
      state.created.push(this);
    }
    onContextLoss(handler: () => void) {
      this.lossHandler = handler;
      return { dispose() {} };
    }
    dispose() {
      this.disposed += 1;
    }
    loseContext() {
      this.lossHandler?.();
    }
  }
  return { state, FakeAddon };
});
type FakeAddon = InstanceType<typeof hoisted.FakeAddon>;
const created = hoisted.state.created as FakeAddon[];

vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: hoisted.FakeAddon }));
vi.mock("../services/terminalWindows", () => ({ isSecondaryTerminalWindow: () => false }));

import {
  GPU_REATTACH_DELAYS_MS,
  attachGpuRenderer,
  detachGpuRenderer,
  gpuRendererDisabled,
} from "../components/gpuRenderer";

function fakeTerm() {
  return {
    rows: 24,
    loaded: [] as unknown[],
    refreshes: [] as Array<[number, number]>,
    loadAddon(a: unknown) {
      this.loaded.push(a);
    },
    refresh(a: number, b: number) {
      this.refreshes.push([a, b]);
    },
  };
}
type Slot = { current: FakeAddon | null };

beforeEach(() => {
  created.length = 0;
  hoisted.state.failConstruct = false;
  localStorage.clear();
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    cb();
    return 1;
  });
});
afterEach(() => vi.unstubAllGlobals());

const attach = (term: ReturnType<typeof fakeTerm>, slot: Slot, lost?: () => void) =>
  attachGpuRenderer(term as never, slot as never, lost);

describe("attachGpuRenderer", () => {
  it("loads the addon, remembers it and paints every row", () => {
    const term = fakeTerm();
    const slot: Slot = { current: null };
    attach(term, slot);
    expect(created).toHaveLength(1);
    expect(slot.current).toBe(created[0]);
    expect(term.loaded).toEqual([created[0]]);
    expect(term.refreshes).toContainEqual([0, 23]);
  });

  it("does nothing when the pane already has one", () => {
    const term = fakeTerm();
    const slot: Slot = { current: null };
    attach(term, slot);
    attach(term, slot);
    expect(created).toHaveLength(1);
  });

  it("never breaks the terminal when WebGL is unavailable", () => {
    hoisted.state.failConstruct = true;
    const slot: Slot = { current: null };
    expect(() => attach(fakeTerm(), slot)).not.toThrow();
    expect(slot.current).toBeNull();
  });

  it('is switched off by localStorage kai_renderer = "dom"', () => {
    localStorage.setItem("kai_renderer", "dom");
    expect(gpuRendererDisabled()).toBe(true);
    const slot: Slot = { current: null };
    attach(fakeTerm(), slot);
    expect(created).toHaveLength(0);
    expect(slot.current).toBeNull();
  });
});

describe("a lost context", () => {
  it("disposes the addon, empties the slot, tells the caller and repaints the DOM renderer", () => {
    const term = fakeTerm();
    const slot: Slot = { current: null };
    const lost = vi.fn();
    attach(term, slot, lost);
    term.refreshes.length = 0;

    created[0].loseContext();

    expect(created[0].disposed).toBe(1);
    expect(slot.current).toBeNull();
    expect(lost).toHaveBeenCalledTimes(1);
    expect(term.refreshes).toContainEqual([0, 23]);
  });

  it("a late loss report from an addon that was already replaced leaves the new one alone", () => {
    const term = fakeTerm();
    const slot: Slot = { current: null };
    attach(term, slot);
    const old = created[0];
    detachGpuRenderer(slot as never);
    attach(term, slot);
    old.loseContext();
    expect(slot.current).toBe(created[1]);
  });
});

describe("detachGpuRenderer", () => {
  it("disposes and empties the slot, and is harmless when empty or already disposed", () => {
    const slot: Slot = { current: null };
    attach(fakeTerm(), slot);
    detachGpuRenderer(slot as never);
    expect(created[0].disposed).toBe(1);
    expect(slot.current).toBeNull();
    expect(() => detachGpuRenderer(slot as never)).not.toThrow();
  });
});

describe("re-attach schedule", () => {
  it("is a few bounded tries, so a GPU that cannot keep a context never loops", () => {
    expect(GPU_REATTACH_DELAYS_MS.length).toBeGreaterThan(0);
    expect(GPU_REATTACH_DELAYS_MS.length).toBeLessThanOrEqual(5);
    expect([...GPU_REATTACH_DELAYS_MS].sort((a, b) => a - b)).toEqual([...GPU_REATTACH_DELAYS_MS]);
  });
});
