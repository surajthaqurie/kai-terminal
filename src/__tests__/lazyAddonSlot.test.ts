import { describe, expect, it, vi } from "vitest";
import { createLazyAddonSlot } from "../services/xtermLazyAddons";

class Addon {
  static made = 0;
  id = ++Addon.made;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  const host = { loadAddon: vi.fn() };
  let term: typeof host | null = host;
  const loads: Array<ReturnType<typeof deferred<typeof Addon>>> = [];
  const load = vi.fn(() => {
    const d = deferred<typeof Addon>();
    loads.push(d);
    return d.promise;
  });
  const onAttach = vi.fn();
  const slot = createLazyAddonSlot<Addon>(load, () => term, onAttach);
  return { host, slot, load, loads, onAttach, setTerm: (t: typeof host | null) => (term = t) };
}

describe("createLazyAddonSlot", () => {
  it("loads nothing until first use", () => {
    const h = setup();
    expect(h.load).not.toHaveBeenCalled();
    expect(h.slot.current()).toBeNull();
  });

  it("loads once, attaches once, and shares the result between concurrent callers", async () => {
    const h = setup();
    const a = h.slot.ensure();
    const b = h.slot.ensure();
    expect(h.load).toHaveBeenCalledTimes(1);
    h.loads[0].resolve(Addon);
    const [x, y] = await Promise.all([a, b]);
    expect(x).toBe(y);
    expect(x).toBeInstanceOf(Addon);
    expect(h.host.loadAddon).toHaveBeenCalledTimes(1);
    expect(h.host.loadAddon).toHaveBeenCalledWith(x);
    expect(h.onAttach).toHaveBeenCalledWith(x);
    expect(h.slot.current()).toBe(x);
    expect(await h.slot.ensure()).toBe(x);
    expect(h.load).toHaveBeenCalledTimes(1);
  });

  it("drops an add-on whose load finishes after a reset (pane torn down)", async () => {
    const h = setup();
    const pending = h.slot.ensure();
    h.slot.reset();
    h.loads[0].resolve(Addon);
    expect(await pending).toBeNull();
    expect(h.host.loadAddon).not.toHaveBeenCalled();
    expect(h.slot.current()).toBeNull();
  });

  it("loads again after a reset (the terminal was rebuilt)", async () => {
    const h = setup();
    const first = h.slot.ensure();
    h.loads[0].resolve(Addon);
    const a = await first;
    h.slot.reset();
    const second = h.slot.ensure();
    h.loads[1].resolve(Addon);
    const b = await second;
    expect(b).not.toBe(a);
    expect(h.host.loadAddon).toHaveBeenCalledTimes(2);
  });

  it("returns null without a terminal, and retries on the next use", async () => {
    const h = setup();
    h.setTerm(null);
    const first = h.slot.ensure();
    h.loads[0].resolve(Addon);
    expect(await first).toBeNull();
    h.setTerm(h.host);
    const second = h.slot.ensure();
    h.loads[1].resolve(Addon);
    expect(await second).toBeInstanceOf(Addon);
  });

  it("a failed load resolves to null and is retried on the next use", async () => {
    const h = setup();
    const first = h.slot.ensure();
    h.loads[0].reject(new Error("chunk failed"));
    expect(await first).toBeNull();
    const second = h.slot.ensure();
    expect(h.load).toHaveBeenCalledTimes(2);
    h.loads[1].resolve(Addon);
    expect(await second).toBeInstanceOf(Addon);
  });
});
