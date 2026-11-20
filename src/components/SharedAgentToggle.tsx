import { FC, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Share2 } from "lucide-react";
import type { ShareStatus } from "../core/sharedAgent/types";
import { getShareStatus, onSharedAgentEvent, setSharing } from "../services/sharedAgentService";
import { PopupMenu, type MenuEntry } from "./PopupMenu";

interface SharedAgentToggleProps {
  /** Opens AI Providers → Shared Agent (invites, connected PCs, internet access). */
  onOpenSharedAgent: () => void;
}

/**
 * The title-bar switch for "Share my agents". One click turns sharing on or
 * off; the caret opens the Shared Agent panel for invites and connected PCs.
 *
 * Sharing is always off when Kai starts, so nothing is asked of the engine
 * until sharing is turned on here or in the panel; after that it follows the
 * engine's "share" events, so both places always agree.
 */
export const SharedAgentToggle: FC<SharedAgentToggleProps> = ({ onOpenSharedAgent }) => {
  const [share, setShare] = useState<ShareStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let off = () => {};
    let cancelled = false;
    void onSharedAgentEvent((e) => {
      if (e.event === "service_exit") setShare(null);
      if (e.event !== "share") return;
      void getShareStatus().then((r) => {
        if (r.ok) setShare(r.value);
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

  const on = share?.enabled === true;
  const connected = share?.devices.filter((d) => d.state === "connected").length ?? 0;

  const toggle = useCallback(async () => {
    setBusy(true);
    const r = await setSharing(!on);
    setBusy(false);
    if (r.ok) {
      setShare(r.value);
      setError(null);
    } else {
      setError(r.error.message);
    }
  }, [on]);

  const status = error
    ? `Shared Agent: ${error}`
    : on
      ? `Sharing your agents · ${connected} PC${connected === 1 ? "" : "s"} connected${
          share?.publicUrl ? " · internet on" : ""
        }`
      : "Sharing is off";

  const entries = useMemo<MenuEntry[]>(
    () => [
      { kind: "heading", id: "share-status", label: status },
      {
        id: "share-toggle",
        label: on ? "Stop sharing" : "Share my agents",
        tone: on ? "danger" : undefined,
        onSelect: () => void toggle(),
      },
      {
        id: "share-open",
        label: "Invites & connected PCs…",
        detail: "AI Providers → Shared Agent",
        onSelect: onOpenSharedAgent,
      },
    ],
    [status, on, toggle, onOpenSharedAgent]
  );

  return (
    <div className="header-editor header-share">
      <button
        type="button"
        className={`header-icon-btn${on ? " is-on" : ""}${error ? " is-error" : ""}`}
        onClick={() => void toggle()}
        disabled={busy}
        aria-pressed={on}
        aria-label={on ? "Stop sharing my agents" : "Share my agents"}
        title={`${status}. Click to ${on ? "stop sharing" : "share your agents"}.`}
      >
        <Share2 size={15} aria-hidden="true" />
        {on && <span className="header-share-dot" aria-hidden="true" />}
      </button>
      <PopupMenu
        label="Shared Agent"
        align="end"
        entries={entries}
        trigger={({ open, toggle: toggleMenu, props }) => (
          <button
            type="button"
            className={`header-caret-btn${open ? " is-open" : ""}`}
            onClick={toggleMenu}
            title="Shared Agent options"
            aria-label="Shared Agent options"
            {...props}
          >
            <ChevronDown size={10} aria-hidden="true" />
          </button>
        )}
      />
    </div>
  );
};
