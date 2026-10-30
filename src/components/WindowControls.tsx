import { FC, useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { isTauriAvailable } from "../services/ptyService";
import { isMacPlatform } from "../services/shortcuts";
import { closeAppWindow, controlAppWindow, watchWindowMaximized } from "../services/appWindow";

/**
 * Minimize / maximize / close for the frameless window (`decorations: false`).
 * Renders nothing in a plain browser, where there is no window to control, and
 * nothing on macOS, which keeps its native traffic lights (see
 * `tauri.macos.conf.json`: overlay title bar) on the left of the tab row.
 */
export const WindowControls: FC = () => {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void watchWindowMaximized(setMaximized).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  if (!isTauriAvailable() || isMacPlatform()) return null;

  return (
    <div className="window-controls" role="group" aria-label="Window controls">
      <button
        type="button"
        className="window-control-btn"
        onClick={() => void controlAppWindow("minimize")}
        title="Minimize"
        aria-label="Minimize window"
      >
        <Minus size={14} />
      </button>
      <button
        type="button"
        className="window-control-btn"
        onClick={() => void controlAppWindow("toggleMaximize")}
        title={maximized ? "Restore" : "Maximize"}
        aria-label={maximized ? "Restore window" : "Maximize window"}
      >
        {maximized ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button
        type="button"
        className="window-control-btn window-control-close"
        onClick={() => void closeAppWindow()}
        title="Close"
        aria-label="Close window"
      >
        <X size={14} />
      </button>
    </div>
  );
};
