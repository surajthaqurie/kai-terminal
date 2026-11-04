import { FC, useEffect, useRef, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { isTauriAvailable } from "../services/ptyService";
import { isMacPlatform } from "../services/shortcuts";
import {
  boxOf,
  closeAppWindow,
  controlAppWindow,
  reportMaximizeButtonBox,
  watchMaximizeButtonState,
  watchWindowMaximized,
  type MaximizeButtonState,
} from "../services/appWindow";

/**
 * Minimize / maximize / close for the frameless window (`decorations: false`).
 * Renders nothing in a plain browser, where there is no window to control, and
 * nothing on macOS, which keeps its native traffic lights (see
 * `tauri.macos.conf.json`: overlay title bar) on the left of the tab row.
 */
export const WindowControls: FC = () => {
  const [maximized, setMaximized] = useState(false);
  const [nativeState, setNativeState] = useState<MaximizeButtonState>("none");
  const maximizeRef = useRef<HTMLButtonElement>(null);
  const showing = isTauriAvailable() && !isMacPlatform();

  // Windows 11 snap layouts: tell the app where the maximize button is. Where
  // Windows takes over the pointer there, the native state drives its look.
  useEffect(() => {
    if (!showing) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let frame = 0;
    const report = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        void reportMaximizeButtonBox(boxOf(maximizeRef.current)).then((active) => {
          if (!cancelled && !active) setNativeState("none");
        });
      });
    };
    void watchMaximizeButtonState((state) => {
      if (!cancelled) setNativeState(state);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    const observer =
      typeof ResizeObserver === "undefined" || !maximizeRef.current
        ? undefined
        : new ResizeObserver(report);
    if (maximizeRef.current) observer?.observe(maximizeRef.current);
    window.addEventListener("resize", report);
    report();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", report);
      observer?.disconnect();
      unlisten?.();
      void reportMaximizeButtonBox(null);
    };
  }, [showing]);

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

  if (!showing) return null;

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
        ref={maximizeRef}
        type="button"
        className={`window-control-btn${nativeState === "none" ? "" : ` is-native-${nativeState}`}`}
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
