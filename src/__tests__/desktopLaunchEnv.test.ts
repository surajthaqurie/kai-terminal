import { afterEach, describe, expect, it, vi } from "vitest";

const spawnCalls = vi.hoisted(() => [] as Array<{ cmd: string; env: NodeJS.ProcessEnv }>);

vi.mock("child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("child_process")>();
  return {
    ...orig,
    spawn: (cmd: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      spawnCalls.push({ cmd, env: opts.env });
      return { unref: () => {} };
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

  it("never pins Code Mode through the launch env", () => {
    // An env var is frozen into the app process: `kai stop code` and the end
    // of an agent run can clear the state file but not the env, which used to
    // leave the footer on Code Mode forever.
    expect(launchKaiApp("/opt/kai/kai", "/repo/demo")).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].env.KAI_ACTIVE_PROJECT).toBeUndefined();
    expect(spawnCalls[0].env.KAI_MODE).toBeUndefined();
  });

  it("drops a stale Code Mode env inherited from an older Kai tab", () => {
    process.env.KAI_ACTIVE_PROJECT = "/repo/old";
    process.env.KAI_MODE = "code";
    expect(launchKaiApp("/opt/kai/kai", "/repo/demo")).toBe(true);
    expect(spawnCalls[0].env.KAI_ACTIVE_PROJECT).toBeUndefined();
    expect(spawnCalls[0].env.KAI_MODE).toBeUndefined();
  });
});
