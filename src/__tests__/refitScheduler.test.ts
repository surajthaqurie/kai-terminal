import { describe, expect, it, vi } from "vitest";
import { createRefitScheduler, type RefitTimers } from "../hooks/useWindowRefit";

/** Hand-driven clock + timers. */
function fakeClock() {
  let now = 1_000;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: RefitTimers = {
    setTimeout: (fn, ms) => {
      const id = next++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle) => void pending.delete(handle as number),
    now: () => now,
  };
  return {
    timers,
    advance(ms: number) {
      const target = now + ms;
      // Run timers in order, moving the clock to each one's time.
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        pending.delete(due[0]);
        due[1].fn();
      }
      now = target;
    },
    get pendingTimers() {
      return pending.size;
    },
  };
}

describe("createRefitScheduler (window resize / focus refits)", () => {
  it("collapses a drag-resize burst into one pass after it settles, plus the follow-ups", () => {
    const clock = fakeClock();
    const pass = vi.fn();
    const scheduler = createRefitScheduler(pass, clock.timers);

    // 2 seconds of dragging: a resize event every 10 ms.
    for (let i = 0; i < 200; i++) {
      scheduler.burst();
      clock.advance(10);
    }
    expect(pass).not.toHaveBeenCalled(); // nothing during the drag (the ResizeObserver follows it live)

    clock.advance(100); // the drag stops: one pass once it has been quiet for the settle time
    expect(pass).toHaveBeenCalledTimes(1);
    clock.advance(150);
    expect(pass).toHaveBeenCalledTimes(2);
    clock.advance(500);
    expect(pass).toHaveBeenCalledTimes(3); // 1 settled + 2 follow-ups, versus 200 + 400 before
    expect(clock.pendingTimers).toBe(0); // and nothing is left queued
  });

  it("a new resize cancels follow-ups still pending from the previous burst", () => {
    const clock = fakeClock();
    const pass = vi.fn();
    const scheduler = createRefitScheduler(pass, clock.timers);

    scheduler.burst();
    clock.advance(100);
    expect(pass).toHaveBeenCalledTimes(1);
    expect(clock.pendingTimers).toBe(2); // the 150 ms and 500 ms follow-ups

    scheduler.burst(); // the window is being resized again
    expect(clock.pendingTimers).toBe(1); // the stale follow-ups are gone; only the settle timer
    clock.advance(100);
    expect(pass).toHaveBeenCalledTimes(2);
  });

  it("focus and visibility signals refit at once, and several in the same instant share one pass", () => {
    const clock = fakeClock();
    const pass = vi.fn();
    const scheduler = createRefitScheduler(pass, clock.timers);

    // Regaining focus fires `window focus`, Tauri's focus event and visibilitychange together.
    scheduler.now();
    scheduler.now();
    scheduler.now();
    expect(pass).toHaveBeenCalledTimes(1);
    expect(clock.pendingTimers).toBe(2); // one set of follow-ups, not three

    clock.advance(1000);
    expect(pass).toHaveBeenCalledTimes(3); // immediate + 150 ms + 500 ms
  });

  it("an immediate signal later on still refits right away", () => {
    const clock = fakeClock();
    const pass = vi.fn();
    const scheduler = createRefitScheduler(pass, clock.timers);
    scheduler.now();
    clock.advance(2000);
    pass.mockClear();
    scheduler.now();
    expect(pass).toHaveBeenCalledTimes(1);
  });

  it("an immediate signal during a burst takes over (the window is visible again)", () => {
    const clock = fakeClock();
    const pass = vi.fn();
    const scheduler = createRefitScheduler(pass, clock.timers);
    scheduler.burst();
    clock.advance(20);
    scheduler.now(); // e.g. the window was restored mid-resize
    expect(pass).toHaveBeenCalledTimes(1);
    clock.advance(2000);
    expect(pass).toHaveBeenCalledTimes(3); // immediate + follow-ups; the pending settle was superseded
  });

  it("dispose cancels everything", () => {
    const clock = fakeClock();
    const pass = vi.fn();
    const scheduler = createRefitScheduler(pass, clock.timers);
    scheduler.burst();
    scheduler.now();
    scheduler.dispose();
    expect(clock.pendingTimers).toBe(0);
    clock.advance(5000);
    scheduler.now();
    scheduler.burst();
    clock.advance(5000);
    expect(pass).toHaveBeenCalledTimes(1); // only the immediate pass before dispose
  });

  it("a pass that throws never prevents the follow-ups", () => {
    const clock = fakeClock();
    let calls = 0;
    const scheduler = createRefitScheduler(() => {
      calls += 1;
      if (calls === 1) throw new Error("layout in transition");
    }, clock.timers);
    expect(() => scheduler.now()).not.toThrow(); // contained by the scheduler itself
    clock.advance(1000);
    expect(calls).toBe(3);
  });
});
