import { useEffect, useState } from "react";
import type { ShareStatus } from "../core/sharedAgent/types";
import { getShareStatus, onSharedAgentEvent } from "../services/sharedAgentService";

export interface SharingSummary {
  on: boolean;
  connected: number;
  internet: boolean;
}

export const summarizeSharing = (share: ShareStatus | null): SharingSummary => ({
  on: share?.enabled === true,
  connected: share?.devices.filter((d) => d.state === "connected").length ?? 0,
  internet: Boolean(share?.enabled && share.publicUrl),
});

/**
 * Whether "Share my agents" is on, for the title-bar status dot.
 *
 * Sharing is always off when Kai starts, so nothing is asked of the engine
 * until it reports a change: then this follows its "share" events, and an
 * engine that stops means sharing is off.
 */
export function useSharingStatus(): SharingSummary {
  const [share, setShare] = useState<ShareStatus | null>(null);

  useEffect(() => {
    let off = () => {};
    let cancelled = false;
    void onSharedAgentEvent((e) => {
      if (e.event === "service_exit") setShare(null);
      if (e.event !== "share") return;
      void getShareStatus().then((r) => {
        if (!cancelled && r.ok) setShare(r.value);
      });
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else off = unlisten;
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return summarizeSharing(share);
}
