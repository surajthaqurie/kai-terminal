// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import type { UpdateCheckResult } from "../services/updateService";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const checkForUpdates = vi.fn();
const recordCheckTime = vi.fn();
const consumeOutcome = vi.fn((_version: string): unknown => null);

vi.mock("../services/updateService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/updateService")>()),
  checkForUpdates: (v: string) => checkForUpdates(v),
  recordCheckTime: () => recordCheckTime(),
  getAppVersion: async () => "1.0.0",
  consumeUpdateOutcome: (v: string) => consumeOutcome(v),
}));
vi.mock("../services/cacheJanitor", () => ({ runCacheJanitor: vi.fn() }));

import { useAppUpdates } from "../hooks/useAppUpdates";

const base: UpdateCheckResult = {
  currentVersion: "1.0.0",
  latestVersion: null,
  updateAvailable: false,
  releaseUrl: null,
  releaseName: null,
  releaseAuthor: null,
  publishedAt: null,
  assets: [],
  selectedAsset: null,
  selectedAssetLabel: null,
  error: null,
  checkedAt: 0,
};
const found: UpdateCheckResult = { ...base, latestVersion: "1.1.0", updateAvailable: true };
const failed: UpdateCheckResult = { ...base, error: "Update check failed (HTTP 503)" };

let api: ReturnType<typeof useAppUpdates>;
let autoCheck = false;
function Harness() {
  api = useAppUpdates({ autoCheckUpdates: autoCheck, setLastError: vi.fn() });
  return null;
}

let unmount: () => void;
let root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  checkForUpdates.mockReset();
  recordCheckTime.mockReset();
  consumeOutcome.mockReset();
  consumeOutcome.mockReturnValue(null);
  autoCheck = false;
  localStorage.clear();
  const host = document.createElement("div");
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
  unmount = () => act(() => root.unmount());
});
afterEach(() => unmount());

describe("update check state", () => {
  it("keeps a known update when a later background check fails", async () => {
    checkForUpdates.mockResolvedValueOnce(found).mockResolvedValueOnce(failed);
    await act(async () => api.checkUpdates(false));
    expect(api.updateInfo?.updateAvailable).toBe(true);

    await act(async () => api.checkUpdates(false));
    expect(api.updateInfo?.updateAvailable).toBe(true);
    expect(api.updateInfo?.latestVersion).toBe("1.1.0");
  });

  it("shows the failure when the user asked for the check", async () => {
    checkForUpdates.mockResolvedValueOnce(found).mockResolvedValueOnce(failed);
    await act(async () => api.checkUpdates(false));
    await act(async () => api.checkUpdates(true));
    expect(api.updateInfo?.error).toBe("Update check failed (HTTP 503)");
  });

  it("only counts a check that reached GitHub as done (a failed one is retried next launch)", async () => {
    checkForUpdates.mockResolvedValueOnce(failed).mockResolvedValueOnce(found);
    await act(async () => api.checkUpdates(false));
    expect(recordCheckTime).not.toHaveBeenCalled();
    await act(async () => api.checkUpdates(false));
    expect(recordCheckTime).toHaveBeenCalledTimes(1);
  });
});

describe("startup work runs once per launch", () => {
  const outcome = { kind: "installed", version: "1.1.0" };

  it("keeps an undismissed update-result notice when the auto-check setting is toggled", async () => {
    unmount(); // beforeEach already mounted (and consumed) once
    consumeOutcome.mockReset();
    consumeOutcome.mockReturnValueOnce(outcome).mockReturnValue(null);
    const host = document.createElement("div");
    root = createRoot(host);
    autoCheck = true;
    await act(async () => root.render(<Harness />));
    await act(async () => {});
    expect(api.updateOutcome).toEqual(outcome);

    // The user flips "automatically check for updates" off: the schedule re-arms,
    // but the one-shot startup read (consume-on-read) must not run again.
    autoCheck = false;
    await act(async () => root.render(<Harness />));
    await act(async () => {});
    expect(consumeOutcome).toHaveBeenCalledTimes(1);
    expect(api.updateOutcome).toEqual(outcome);
    unmount = () => act(() => root.unmount());
  });
});
