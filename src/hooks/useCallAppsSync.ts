import { useEffect } from "react";
import { syncExtraCallApps } from "../services/callAppsService";

/**
 * Keeps the backend call watcher's extra call-app list in step with Settings:
 * pushed once at startup and again whenever the list changes.
 */
export function useCallAppsSync(extraCallApps: readonly string[] | undefined) {
  const key = (extraCallApps ?? []).join("\n");
  useEffect(() => {
    void syncExtraCallApps(key ? key.split("\n") : []);
  }, [key]);
}
