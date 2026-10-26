import { useCallback, useEffect, useMemo, useState } from "react";
import { PtyService, isTauriAvailable } from "../services/ptyService";
import { DEFAULT_SETTINGS, SettingsService } from "../services/settingsService";
import { withSkipProfileArgs } from "../services/shellArgs";
import { zoomedFontSize } from "../services/shortcuts";
import type { ShellProfile, UserSettings } from "../types/terminal";
import { useLatest } from "./useLatest";

interface TerminalConfigOptions {
  /** Surfaces failures (shell discovery, autostart) in Diagnostics. */
  setLastError: (message: string | null) => void;
  /** Settings modal visibility: autostart is only reconciled while it is open. */
  isSettingsOpen: boolean;
  /** Runs after every saved preferences change (e.g. to resync music mute). */
  onSettingsSaved?: (next: UserSettings) => void;
}

/**
 * User preferences, theme application and shell profiles — the settings the
 * terminal panes are configured from. `selectedShell` is the effective
 * profile (custom path override + skip-profile fast launch applied).
 */
export function useTerminalConfig({
  setLastError,
  isSettingsOpen,
  onSettingsSaved,
}: TerminalConfigOptions) {
  const [userSettings, setUserSettings] = useState<UserSettings>(() =>
    SettingsService.loadSettings()
  );
  const [shells, setShells] = useState<ShellProfile[]>([]);
  const [selectedShellId, setSelectedShellId] = useState<string>("");
  // Live mirrors for long-lived callbacks (pty-exit recycle path).
  const shellsRef = useLatest(shells);
  const selectedShellIdRef = useLatest(selectedShellId);
  const onSettingsSavedRef = useLatest(onSettingsSaved);

  // On startup, detect host terminal preferences (Kali Linux terminal / system font) and sync defaults
  useEffect(() => {
    if (!isTauriAvailable()) return;
    void SettingsService.loadSystemDefaults().then((sysDefaults) => {
      if (sysDefaults && Object.keys(sysDefaults).length > 0) {
        setUserSettings((prev) => {
          const isDefaultFont =
            prev.fontFamily === DEFAULT_SETTINGS.fontFamily ||
            prev.fontFamily === 'Menlo, Monaco, "Courier New", monospace';
          const isDefaultSize = prev.fontSize === 14 || prev.fontSize === 12;
          return {
            ...prev,
            ...(isDefaultFont && sysDefaults.fontFamily
              ? { fontFamily: sysDefaults.fontFamily }
              : {}),
            ...(isDefaultSize ? { fontSize: 12 } : {}),
            ...(prev.theme === "kali" && sysDefaults.theme ? { theme: sysDefaults.theme } : {}),
          };
        });
      }
    });
  }, []);

  // Synchronize active theme to documentElement, body, color-scheme, and theme-color meta
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", userSettings.theme);
    document.body.setAttribute("data-theme", userSettings.theme);
    document.documentElement.style.colorScheme =
      userSettings.theme === "solarized-light" ? "light" : "dark";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content", SettingsService.getThemeCanvasColor(userSettings.theme));
    }
  }, [userSettings.theme]);

  // Load available shell profiles on startup
  useEffect(() => {
    PtyService.getAvailableShells()
      .then((loadedShells) => {
        setShells(loadedShells);
        const configuredDefault = loadedShells.find((s) => s.id === userSettings.defaultShellId);
        const defaultShell =
          configuredDefault || loadedShells.find((s) => s.is_default) || loadedShells[0];
        if (defaultShell) {
          setSelectedShellId(defaultShell.id);
        }
      })
      .catch((err) => {
        console.error("Failed to load available shells:", err);
        setLastError(err instanceof Error ? err.message : String(err));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconcile the stored launch-at-startup preference with the real OS
  // state (user may have toggled it in OS settings outside the app). The OS
  // is the source of truth; the stored setting follows it.
  // Resolved when Settings opens — never at startup: on Windows this spawns
  // `reg.exe query`, and a child process during the first PTY spawn is a
  // classic "Not Responding on launch" trigger.
  useEffect(() => {
    if (!isSettingsOpen) return;
    let cancelled = false;
    // Deferred past first paint: the modal renders instantly, then the
    // `reg.exe query` IPC reconciles in the background (Settings-open
    // stall fix). Backend no longer flashes a console for this either.
    const timer = setTimeout(() => {
      void import("../services/autostartService")
        .then(({ getAutostartEnabled }) => getAutostartEnabled())
        .then((enabled) => {
          if (cancelled) return;
          setUserSettings((prev) =>
            Boolean(prev.launchAtStartup) === enabled ? prev : { ...prev, launchAtStartup: enabled }
          );
        })
        .catch(() => {
          // Mock/browser mode or backend unavailable: keep stored preference.
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isSettingsOpen]);

  // Saving preferences applies a changed default shell to new sessions
  // and syncs the launch-at-startup toggle with the OS (all platforms).
  const saveSettings = useCallback(
    (next: UserSettings) => {
      if (
        next.defaultShellId &&
        next.defaultShellId !== userSettings.defaultShellId &&
        shells.some((s) => s.id === next.defaultShellId)
      ) {
        setSelectedShellId(next.defaultShellId);
      }
      if (Boolean(next.launchAtStartup) !== Boolean(userSettings.launchAtStartup)) {
        void import("../services/autostartService").then(({ setAutostartEnabled }) =>
          setAutostartEnabled(Boolean(next.launchAtStartup)).catch((err) => {
            console.error("Failed to apply launch-at-startup setting:", err);
            setLastError(err instanceof Error ? err.message : String(err));
          })
        );
      }
      setUserSettings(next);
      onSettingsSavedRef.current?.(next);
    },
    [
      shells,
      userSettings.defaultShellId,
      userSettings.launchAtStartup,
      setLastError,
      onSettingsSavedRef,
    ]
  );

  /** Ctrl+= / Ctrl+- / Ctrl+0: zoom the terminal font for this session. */
  const zoomFont = useCallback((delta: 1 | -1 | 0) => {
    const base = SettingsService.loadSettings().fontSize;
    setUserSettings((prev) => ({
      ...prev,
      fontSize: zoomedFontSize(prev.fontSize, delta, base),
    }));
  }, []);

  // Effective shell: a custom binary path wins over the stored profile path,
  // so a configured custom shell is actually used for new tabs instead of
  // silently falling back to the profile (the "binary not runnable" mismatch).
  const baseShell = shells.find((s) => s.id === selectedShellId);
  const customPath = userSettings.customShellPath?.trim();
  const effectiveShellPath = customPath || baseShell?.path;
  const skipShellProfile = userSettings.skipShellProfile === true;
  // Fast-launch option: with `skipShellProfile`, PowerShell/pwsh spawns gain
  // -NoProfile (profile scripts dominate cold-start time on Windows).
  const selectedShell: ShellProfile | undefined = useMemo(
    () =>
      withSkipProfileArgs(
        customPath
          ? {
              id: baseShell?.id ?? "custom",
              name: baseShell ? `${baseShell.name} (custom)` : "Custom Shell",
              path: customPath,
              args: baseShell?.args,
              is_default: baseShell?.is_default ?? true,
              is_wsl: baseShell?.is_wsl ?? false,
            }
          : baseShell,
        skipShellProfile
      ),
    [baseShell, customPath, skipShellProfile]
  );

  return {
    userSettings,
    setUserSettings,
    saveSettings,
    zoomFont,
    shells,
    selectedShellId,
    setSelectedShellId,
    shellsRef,
    selectedShellIdRef,
    selectedShell,
    effectiveShellPath,
  };
}
