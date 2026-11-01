import { afterEach, describe, expect, it, vi } from "vitest";

const spawnCalls = vi.hoisted(() => [] as Array<{ cmd: string; env: NodeJS.ProcessEnv }>);

vi.mock("child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("child_process")>();
  return {
    ...orig,
    spawn: (cmd: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      spawnCalls.push({ cmd, env: opts.env });
      const child = {
        unref: () => {},
        // The real child reports a successful start with a 'spawn' event.
        once: (event: string, cb: () => void) => {
          if (event === "spawn") queueMicrotask(cb);
          return child;
        },
      };
      return child;
    },
  };
});

import { launchKaiApp } from "../cli/desktopApp";

describe("launchKaiApp environment", () => {
  afterEach(() => {
    spawnCalls.length = 0;
    delete process.env.KAI_ACTIVE_PROJECT;
    delete process.env.KAI_MODE;
  });

  it("never pins Code Mode through the launch env", async () => {
    // An env var is frozen into the app process: `kai stop code` and the end
    // of an agent run can clear the state file but not the env, which used to
    // leave the footer on Code Mode forever.
    expect(await launchKaiApp("/opt/kai/kai", "/repo/demo")).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].env.KAI_ACTIVE_PROJECT).toBeUndefined();
    expect(spawnCalls[0].env.KAI_MODE).toBeUndefined();
  });

  it("drops a stale Code Mode env inherited from an older Kai tab", async () => {
    process.env.KAI_ACTIVE_PROJECT = "/repo/old";
    process.env.KAI_MODE = "code";
    expect(await launchKaiApp("/opt/kai/kai", "/repo/demo")).toBe(true);
    expect(spawnCalls[0].env.KAI_ACTIVE_PROJECT).toBeUndefined();
    expect(spawnCalls[0].env.KAI_MODE).toBeUndefined();
  });
});
