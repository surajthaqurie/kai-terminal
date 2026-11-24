// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act, FC } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let emitCall: (payload: { active: boolean }) => void = () => {};
let callActiveAtMount = false;

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, cb: (e: { payload: { active: boolean } }) => void) => {
    emitCall = (payload) => cb({ payload });
    return () => {};
  }),
}));
const invokeCalls: Array<[string, unknown]> = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: unknown) => {
    invokeCalls.push([command, args]);
    return callActiveAtMount;
  }),
}));
vi.mock("../services/ptyService", () => ({ isTauriAvailable: () => true }));

import { shouldWatchCalls, useCallPause } from "../hooks/useCallPause";

const Probe: FC<{ playing: boolean; pause: () => void; resume: () => void }> = (props) => {
  useCallPause(props);
  return null;
};

async function mount(playing: boolean) {
  const pause = vi.fn();
  const resume = vi.fn();
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<Probe playing={playing} pause={pause} resume={resume} />));
  // async act: awaitable for real (see React 19 act; the sync form is typed void).
  return { pause, resume, unmount: () => act(async () => root.unmount()) };
}

const flush = () => act(async () => {});

describe("useCallPause", () => {
  beforeEach(() => {
    callActiveAtMount = false;
    invokeCalls.length = 0;
    localStorage.clear();
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("pauses when a call starts and resumes when it ends", async () => {
    const { pause, resume } = await mount(true);
    await flush();
    act(() => emitCall({ active: true }));
    expect(pause).toHaveBeenCalledTimes(1);
    act(() => emitCall({ active: false }));
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("does not resume over the user's own Play during the call", async () => {
    const pause = vi.fn();
    const resume = vi.fn();
    const root = createRoot(document.createElement("div"));
    const render = (playing: boolean) =>
      act(async () => root.render(<Probe playing={playing} pause={pause} resume={resume} />));
    await render(true);
    await flush();
    act(() => emitCall({ active: true }));
    expect(pause).toHaveBeenCalledTimes(1);
    await render(false); // the pause took effect
    await render(true); // the user pressed Play mid-call
    await render(false); // ...and then Pause again
    act(() => emitCall({ active: false }));
    expect(resume).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("leaves already-paused music alone", async () => {
    const { pause, resume } = await mount(false);
    await flush();
    act(() => emitCall({ active: true }));
    act(() => emitCall({ active: false }));
    expect(pause).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it("pauses for a call that was already running at mount", async () => {
    callActiveAtMount = true;
    const { pause } = await mount(true);
    // The check is an async chain (dynamic import, then the command): wait for it.
    await vi.waitFor(() => expect(pause).toHaveBeenCalledTimes(1));
  });

  it("does not resume music the user paused during the call themselves", async () => {
    // pause() is called by the hook; a second pause (user action) must not
    // make the hook lose track of its own pause, and resume runs once.
    const { pause, resume } = await mount(true);
    await flush();
    act(() => emitCall({ active: true }));
    act(() => emitCall({ active: true }));
    expect(pause).toHaveBeenCalledTimes(1);
    act(() => emitCall({ active: false }));
    expect(resume).toHaveBeenCalledTimes(1);
  });
});

/** The backend polls only while this says so; the last `call_watch_set_enabled` call wins. */
const watchCalls = () =>
  invokeCalls
    .filter(([cmd]) => cmd === "call_watch_set_enabled")
    .map(([, args]) => (args as { enabled: boolean }).enabled);
const watching = () => {
  const calls = watchCalls();
  return calls[calls.length - 1];
};

describe("shouldWatchCalls", () => {
  it("watches only while playing or while a call holds the player paused", () => {
    expect(shouldWatchCalls(false, false)).toBe(false);
    expect(shouldWatchCalls(true, false)).toBe(true);
    expect(shouldWatchCalls(false, true)).toBe(true); // waiting for the call to end
    expect(shouldWatchCalls(true, true)).toBe(true);
  });
});

describe("useCallPause asks the backend to poll only when needed (RES-01)", () => {
  beforeEach(() => {
    callActiveAtMount = false;
    invokeCalls.length = 0;
  });

  it("never asks for call detection while the player is idle", async () => {
    const { unmount } = await mount(false);
    await flush();
    expect(watchCalls()).not.toContain(true);
    expect(watching()).toBe(false);
    await unmount();
  });

  it("asks for it while playing, keeps it through the call, and stops after the user pauses", async () => {
    const pause = vi.fn();
    const resume = vi.fn();
    const root = createRoot(document.createElement("div"));
    const render = (playing: boolean) =>
      act(async () => root.render(<Probe playing={playing} pause={pause} resume={resume} />));

    await render(true);
    await flush();
    expect(watching()).toBe(true);

    act(() => emitCall({ active: true })); // the call pauses the music...
    await flush();
    await render(false); // ...so `playing` goes false, yet the call must still be watched
    await flush();
    expect(watching()).toBe(true);

    act(() => emitCall({ active: false })); // call over: resume
    await flush();
    expect(resume).toHaveBeenCalledTimes(1);
    await render(true);
    await flush();
    expect(watching()).toBe(true);

    await render(false); // the user pauses the music for good
    await flush();
    expect(watching()).toBe(false);
    act(() => root.unmount());
  });

  it("stops watching when the player goes away", async () => {
    const { unmount } = await mount(true);
    await flush();
    expect(watching()).toBe(true);
    await unmount();
    await flush();
    expect(watching()).toBe(false);
  });
});
