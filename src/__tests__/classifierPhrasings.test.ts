import { describe, expect, it } from "vitest";
import { classifyTask } from "../core/classifier";

describe("classifier: phrasings that used to fall through to `unknown`", () => {
  it.each([
    ["debug why the cache returns stale entries", "debug"],
    ["troubleshoot the slow startup", "debug"],
    ["why does the resolver crash on empty input", "debug"],
    ["review the retrieval ranking", "review"],
    ["audit the update installer flow", "review"],
    ["replace oldHelper with newHelper in the indexer", "refactor"],
  ])("%s -> %s", (task, category) => {
    expect(classifyTask(task).category).toBe(category);
  });

  it.each([
    "rename the function getUser to fetchUser",
    "rename class Order as PurchaseOrder",
    "rename `cancelOrder` to `voidOrder` everywhere",
    'rename the method "start" to "begin"',
    "change the name of loadConfig to readConfig",
    "update the name of the function loadConfig to readConfig",
    "replace `oldHelper` with `newHelper`",
    "migrate from legacyFetch to httpClient",
    "swap lodash for native helpers",
    "switch fooClient to barClient",
    "move parseArgs into its own file",
    "move the helper to a new module",
  ])("recognises %s as a refactor", (task) => {
    expect(classifyTask(task).category).toBe("refactor");
  });

  it("does not treat prose about renaming or moving as a refactor", () => {
    expect(classifyTask("move the cursor to the end of the line").category).not.toBe("refactor");
    expect(classifyTask("explain how the rename flow works").category).toBe("explain");
  });

  it("keeps the established categories", () => {
    expect(classifyTask("Explain how PtyManager handles child processes").category).toBe("explain");
    expect(classifyTask("Implement a new health check endpoint").category).toBe("implement");
    expect(classifyTask("rename foo to bar").category).toBe("refactor");
    expect(classifyTask("write unit tests for the parser").category).toBe("test");
  });

  it("still returns unknown when nothing matches", () => {
    expect(classifyTask("tidy things please").category).toBe("unknown");
  });
});
