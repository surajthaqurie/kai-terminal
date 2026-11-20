import { FC, useCallback, useEffect, useState } from "react";
import { PanelLeftClose } from "lucide-react";
import { useJoinedHosts } from "../hooks/useJoinedHosts";
import {
  closeChatWindow,
  loadChatHandoff,
  saveChatHandoff,
  type ChatSnapshot,
} from "../services/sharedChatWindow";
import { SettingsService, isLightTheme } from "../services/settingsService";
import { SharedAgentChat } from "./SharedAgentChat";

/** The window opens in the person's theme (it has none of the app around it to set it). */
function applySavedTheme(): void {
  try {
    const { theme } = SettingsService.loadSettings();
    document.documentElement.setAttribute("data-theme", theme);
    document.body.setAttribute("data-theme", theme);
    document.documentElement.style.colorScheme = isLightTheme(theme) ? "light" : "dark";
  } catch {
    // The default theme is fine.
  }
}

/**
 * The Shared Agent chat in its own window (`index.html?window=shared-chat`). It
 * carries on the conversation the panel handed over and hands it back on close.
 */
export const SharedChatWindow: FC = () => {
  const [initial] = useState(loadChatHandoff);
  useEffect(applySavedTheme, []);
  const { hosts, loaded, error } = useJoinedHosts(true);
  const [hostId, setHostId] = useState<string | null>(initial?.hostId ?? null);

  useEffect(() => {
    if (hostId && hosts.some((h) => h.id === hostId)) return;
    if (hosts.length) setHostId(hosts.find((h) => h.connected)?.id ?? hosts[0].id);
  }, [hosts, hostId]);

  // Every change is saved at once, so the panel gets the conversation back however
  // this window is closed (its button, the title bar, Alt+F4).
  const onSnapshot = useCallback((s: ChatSnapshot) => saveChatHandoff(s), []);

  return (
    <div className="sa-chat-window">
      {!hosts.length ? (
        <p className="sa-empty" role={error ? "alert" : undefined}>
          {error ??
            (loaded ? "No PC joined. Join one in AI CLI Providers → Shared Agent." : "Loading…")}
        </p>
      ) : (
        <SharedAgentChat
          hosts={hosts}
          hostId={hostId}
          onHostChange={setHostId}
          initial={initial}
          onSnapshot={onSnapshot}
          actions={({ busy }) => (
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => void closeChatWindow()}
              disabled={busy}
              title={busy ? "Wait for the answer, then dock" : "Move the chat back into the panel"}
              aria-label="Dock chat back into the panel"
            >
              <PanelLeftClose size={13} />
              <span>Dock</span>
            </button>
          )}
        />
      )}
    </div>
  );
};
