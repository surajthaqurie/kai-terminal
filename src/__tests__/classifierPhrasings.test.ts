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

  it.each([
    "getUser should be called fetchUser",
    "`cancelOrder` should be named `voidOrder`",
    "the user_id field should be called account_id",
    "loadConfig must be renamed to readConfig",
    "the helper should be renamed to formatDate",
    "the old handler needs to be renamed",
    "foo is misnamed, call it bar",
    "the retry function is badly named; rename it to backoff",
    "rename the getUser function to fetchUser",
    "rename the function from getUser to fetchUser",
    "rename variable from tmp to buffer",
  ])("recognises the rename statement %s as a refactor", (task) => {
    expect(classifyTask(task).category).toBe("refactor");
  });

  it.each([
    "the callback should be called only once",
    "init should be called before start",
    "cancelOrder should be called twice per request",
    "the user should be called back tomorrow",
    "this should be called Bob",
    "what should this be called?",
    "the handler should be named in the docs",
    "explain why the function is named that way",
    "the build is misnamed in the CI log",
  ])("does not treat the prose %s as a rename", (task) => {
    expect(classifyTask(task).category).not.toBe("refactor");
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
