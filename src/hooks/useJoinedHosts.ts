import { useCallback, useEffect, useState } from "react";
import type { JoinedHost } from "../core/sharedAgent/types";
import { listHosts, onSharedAgentEvent } from "../services/sharedAgentService";

/** The last list seen, so reopening the panel shows it at once instead of "Loading…". */
let cache: JoinedHost[] | null = null;

/**
 * The PCs this PC has joined, kept current by the service's `hosts` events.
 * Loads (and asks the service to re-check every PC) whenever `active` turns true;
 * the service answers at once and the check's result arrives as an event.
 */
export function useJoinedHosts(active: boolean) {
  const [hosts, setHostsState] = useState<JoinedHost[]>(cache ?? []);
  const [loaded, setLoaded] = useState(cache !== null);
  const [error, setError] = useState<string | null>(null);

  const setHosts = useCallback((next: JoinedHost[] | ((prev: JoinedHost[]) => JoinedHost[])) => {
    setHostsState((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      cache = value;
      return value;
    });
  }, []);

  const refresh = useCallback(
    async (force = false) => {
      const res = await listHosts(force);
      setLoaded(true);
      if (!res.ok) {
        setError(res.error.message);
        return;
      }
      setError(null);
      setHosts(res.value);
    },
    [setHosts]
  );

  useEffect(() => {
    if (active) void refresh(true);
  }, [active, refresh]);

  useEffect(() => {
    let off = () => {};
    let cancelled = false;
    void onSharedAgentEvent((e) => {
      if (e.event === "hosts") setHosts(e.hosts);
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else off = unlisten;
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [setHosts]);

  return { hosts, setHosts, loaded, error, refresh };
}

/** Test hook: forget the cached list. */
export const resetJoinedHostsCache = (): void => {
  cache = null;
};
