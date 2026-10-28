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
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => callActiveAtMount),
}));
vi.mock("../services/ptyService", () => ({ isTauriAvailable: () => true }));

import { useCallPause } from "../hooks/useCallPause";

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
  return { pause, resume, unmount: () => act(() => root.unmount()) };
}

const flush = () => act(async () => {});

describe("useCallPause", () => {
  beforeEach(() => {
    callActiveAtMount = false;
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
    await flush();
    expect(pause).toHaveBeenCalledTimes(1);
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
