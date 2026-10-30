import { windowTransparencySupported } from "../services/windowOpacity";
import { FC, useState, useEffect } from "react";
import {
  UserSettings,
  ShellProfile,
  ThemeName,
  CursorStyle,
  KeybindingsConfig,
} from "../types/terminal";
import { DEFAULT_SETTINGS, SettingsService } from "../services/settingsService";
import {
  SHORTCUT_ACTION_LABELS,
  FIXED_ACTION_LABELS,
  DEFAULT_FIXED_SHORTCUTS,
  AnyShortcutId,
  FixedActionId,
  ShortcutActionId,
  findConflicts,
  findReservedConflicts,
  validateBinding,
  validateFixedBinding,
  isMacPlatform,
  platformLabel,
  FIXED_SHORTCUT_HELP,
  eventToBindingString,
} from "../services/shortcuts";
import {
  X,
  Save,
  RotateCcw,
  Palette,
  Type,
  Terminal,
  Keyboard,
  ArrowUpCircle,
  Download,
  ExternalLink,
} from "lucide-react";
import { APP_VERSION_FALLBACK } from "../services/updateService";
import type { UpdateCheckResult, UpdateDownloadState } from "../services/updateService";
import { UpdateProgressBar, describeUpdateStep } from "./UpdateProgressBar";

const BINDING_LABELS: Record<AnyShortcutId, string> = {
  ...SHORTCUT_ACTION_LABELS,
  ...FIXED_ACTION_LABELS,
};

export type SettingsTab = "appearance" | "terminal" | "shell" | "shortcuts" | "updates";

export const FONT_PRESETS = [
  {
    label: "JetBrains Mono — bundled (Default)",
    value: DEFAULT_SETTINGS.fontFamily,
  },
  {
    label: "Fira Code (Kali Linux)",
    value: '"Fira Code", monospace',
  },
  {
    label: "System Monospace (OS Default)",
    value:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  },
  {
    label: "DejaVu Sans Mono (Linux)",
    value: '"DejaVu Sans Mono", monospace',
  },
  {
    label: "Ubuntu Mono (Linux)",
    value: '"Ubuntu Mono", monospace',
  },
  {
    label: "Liberation Mono (Linux)",
    value: '"Liberation Mono", monospace',
  },
  {
    label: "Menlo, Monaco (macOS)",
    value: 'Menlo, Monaco, "Courier New", monospace',
  },
  {
    label: "Consolas (Windows)",
    value: 'Consolas, "Lucida Console", monospace',
  },
  {
    label: "JetBrains Mono (installed copy)",
    value: '"JetBrains Mono", monospace',
  },
  {
    label: "Fira Code",
    value: '"Fira Code", monospace',
  },
  {
    label: "Cascadia Code",
    value: '"Cascadia Code", "Cascadia Mono", monospace',
  },
  {
    label: "Source Code Pro",
    value: '"Source Code Pro", monospace',
  },
  {
    label: "Inconsolata",
    value: "Inconsolata, monospace",
  },
  {
    label: "Courier New",
    value: '"Courier New", Courier, monospace',
  },
];

export const THEME_OPTIONS: Array<{
  id: ThemeName;
  name: string;
  bg: string;
  fg: string;
  accent: string;
}> = [
  { id: "kai-dark", name: "Kai Dark (Default)", bg: "#0f1115", fg: "#d9dce3", accent: "#22d3ee" },
  { id: "github-dark", name: "GitHub Dark", bg: "#0d1117", fg: "#c9d1d9", accent: "#58a6ff" },
  { id: "one-dark", name: "One Dark", bg: "#282c34", fg: "#abb2bf", accent: "#61afef" },
  { id: "dracula", name: "Dracula", bg: "#282a36", fg: "#f8f8f2", accent: "#bd93f9" },
  { id: "tokyo-night", name: "Tokyo Night", bg: "#1a1b26", fg: "#c0caf5", accent: "#7aa2f7" },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    bg: "#1e1e2e",
    fg: "#cdd6f4",
    accent: "#89b4fa",
  },
  { id: "gruvbox-dark", name: "Gruvbox Dark", bg: "#282828", fg: "#ebdbb2", accent: "#fabd2f" },
  { id: "nord", name: "Nord", bg: "#2e3440", fg: "#d8dee9", accent: "#88c0d0" },
  { id: "monokai", name: "Monokai", bg: "#272822", fg: "#f8f8f2", accent: "#a6e22e" },
  { id: "solarized-dark", name: "Solarized Dark", bg: "#002b36", fg: "#93a1a1", accent: "#268bd2" },
  { id: "github-light", name: "GitHub Light", bg: "#ffffff", fg: "#24292f", accent: "#0969da" },
  {
    id: "solarized-light",
    name: "Solarized Light",
    bg: "#fdf6e3",
    fg: "#586e75",
    accent: "#268bd2",
  },
];

export const EDITOR_PRESETS = [
  { label: "Auto-Detect (VS Code, Cursor, VSCodium, Sublime, Zed)", value: "" },
  { label: "Visual Studio Code (code)", value: "code" },
  { label: "Cursor (cursor)", value: "cursor" },
  { label: "Windsurf (windsurf)", value: "windsurf" },
  { label: "VSCodium (codium)", value: "codium" },
  { label: "Sublime Text (subl)", value: "subl" },
  { label: "Zed (zed)", value: "zed" },
  { label: "Neovim (nvim)", value: "nvim" },
  { label: "Vim (vim)", value: "vim" },
  { label: "Custom Command / Path...", value: "custom" },
];

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: UserSettings;
  onSaveSettings: (newSettings: UserSettings) => void;
  shells: ShellProfile[];
  appVersion?: string;
  updateInfo?: UpdateCheckResult | null;
  isCheckingUpdates?: boolean;
  updateDownload?: UpdateDownloadState | null;
  onCheckUpdates?: () => void;
  onViewUpdate?: () => void;
  onDownloadAndInstall?: () => void;
}

export const SettingsModal: FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSaveSettings,
  shells,
  appVersion = APP_VERSION_FALLBACK,
  updateInfo = null,
  isCheckingUpdates = false,
  updateDownload = null,
  onCheckUpdates,
  onViewUpdate,
  onDownloadAndInstall,
}) => {
  const [formData, setFormData] = useState<UserSettings>(settings);
  const [activeTab, setActiveTab] = useState<SettingsTab>("appearance");
  const [selectedFontPreset, setSelectedFontPreset] = useState<string>("custom");
  const [selectedEditorPreset, setSelectedEditorPreset] = useState<string>("");
  const [recordingAction, setRecordingAction] = useState<string | null>(null);
  const [bindingErrors, setBindingErrors] = useState<Record<string, string>>({});
  const isMac = isMacPlatform();

  useEffect(() => {
    setFormData(settings);
    setBindingErrors({});
    const matchedFont = FONT_PRESETS.find((p) => p.value === settings.fontFamily);
    setSelectedFontPreset(matchedFont ? matchedFont.value : "custom");

    const currentEditor = (settings.editorPath || "").trim();
    const matchedEditor = EDITOR_PRESETS.find((e) => e.value === currentEditor);
    setSelectedEditorPreset(matchedEditor ? matchedEditor.value : currentEditor ? "custom" : "");
  }, [settings, isOpen]);

  // Live theme preview while choosing theme in Settings
  useEffect(() => {
    if (!isOpen) return;
    if (formData.theme) {
      document.documentElement.setAttribute("data-theme", formData.theme);
      document.body.setAttribute("data-theme", formData.theme);
      document.documentElement.style.colorScheme =
        formData.theme === "solarized-light" ? "light" : "dark";
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) {
        meta.setAttribute("content", SettingsService.getThemeCanvasColor(formData.theme));
      }
    }
  }, [formData.theme, isOpen]);

  const handleCancel = () => {
    document.documentElement.setAttribute("data-theme", settings.theme);
    document.body.setAttribute("data-theme", settings.theme);
    document.documentElement.style.colorScheme =
      settings.theme === "solarized-light" ? "light" : "dark";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content", SettingsService.getThemeCanvasColor(settings.theme));
    }
    onClose();
  };

  if (!isOpen) return null;

  const conflicts = findConflicts(formData.keybindings, formData.fixedKeybindings);
  const conflictedActions = new Set<AnyShortcutId>(conflicts.flatMap((c) => c.actions));
  // Combos the app handles itself would never reach a user binding.
  const reservedConflicts = findReservedConflicts(formData.keybindings);
  const reservedFor = new Map<AnyShortcutId, string>(
    reservedConflicts.map((c) => [c.action, c.reservedFor])
  );

  const isFixedAction = (action: AnyShortcutId): action is FixedActionId =>
    action in DEFAULT_FIXED_SHORTCUTS;
  const bindingFor = (action: AnyShortcutId): string =>
    isFixedAction(action)
      ? (formData.fixedKeybindings?.[action] ?? DEFAULT_FIXED_SHORTCUTS[action])
      : formData.keybindings[action];

  const bindingGroups: Array<{ heading?: string; actions: AnyShortcutId[] }> = [
    { actions: Object.keys(SHORTCUT_ACTION_LABELS) as ShortcutActionId[] },
    {
      heading: "Terminal keys (zoom, copy / paste, scroll, tab jump)",
      actions: Object.keys(FIXED_ACTION_LABELS) as FixedActionId[],
    },
  ];

  const handleBindingChange = (action: AnyShortcutId, value: string) => {
    let err: string | null;
    if (isFixedAction(action)) {
      setFormData({
        ...formData,
        fixedKeybindings: {
          ...DEFAULT_FIXED_SHORTCUTS,
          ...formData.fixedKeybindings,
          [action]: value,
        },
      });
      err = validateFixedBinding(action, value);
    } else {
      const next: KeybindingsConfig = {
        ...formData.keybindings,
        [action]: value,
      };
      setFormData({ ...formData, keybindings: next });
      err = validateBinding(value);
    }
    setBindingErrors((prev) => {
      const copy = { ...prev };
      if (err) copy[action] = err;
      else delete copy[action];
      return copy;
    });
  };

  const handleResetBindings = () => {
    setFormData({
      ...formData,
      keybindings: { ...DEFAULT_SETTINGS.keybindings },
      fixedKeybindings: { ...DEFAULT_FIXED_SHORTCUTS },
    });
    setBindingErrors({});
    setRecordingAction(null);
  };

  const handleFontPresetChange = (val: string) => {
    setSelectedFontPreset(val);
    if (val !== "custom") {
      setFormData((prev) => ({ ...prev, fontFamily: val }));
    }
  };

  const handleEditorPresetChange = (val: string) => {
    setSelectedEditorPreset(val);
    if (val !== "custom") {
      setFormData((prev) => ({ ...prev, editorPath: val }));
    }
  };

  const handleShortcutKeyDown = (action: AnyShortcutId, e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setRecordingAction(null);
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      handleBindingChange(action, "");
      return;
    }
    const captured = eventToBindingString(e.nativeEvent, isMac);
    if (captured) {
      e.preventDefault();
      e.stopPropagation();
      handleBindingChange(action, captured);
      setRecordingAction(null);
    }
  };

  const hasBindingErrors =
    Object.keys(bindingErrors).length > 0 || conflicts.length > 0 || reservedConflicts.length > 0;

  const handleSave = () => {
    if (hasBindingErrors) return;
    const normalized = SettingsService.normalize(formData);
    SettingsService.saveSettings(normalized);
    onSaveSettings(normalized);
    onClose();
  };

  const handleReset = () => {
    setFormData(DEFAULT_SETTINGS);
    setBindingErrors({});
    document.documentElement.setAttribute("data-theme", DEFAULT_SETTINGS.theme);
    document.body.setAttribute("data-theme", DEFAULT_SETTINGS.theme);
    document.documentElement.style.colorScheme = "dark";
    const matchedFont = FONT_PRESETS.find((p) => p.value === DEFAULT_SETTINGS.fontFamily);
    setSelectedFontPreset(matchedFont ? matchedFont.value : "custom");
    setSelectedEditorPreset("");
    setRecordingAction(null);
  };

  const currentOpacityPercent = Math.round((formData.opacity ?? 1.0) * 100);

  return (
    <div className="modal-backdrop" onClick={handleCancel}>
      <div className="settings-modal settings-tabs-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Settings</h3>
          <button className="btn-close" onClick={handleCancel} title="Close">
            <X size={18} />
          </button>
        </div>

        {/* Tab Navigation Header */}
        <div className="modal-tabs" role="tablist">
          <button
            type="button"
            className={`modal-tab-btn ${activeTab === "appearance" ? "active" : ""}`}
            onClick={() => setActiveTab("appearance")}
            role="tab"
            aria-selected={activeTab === "appearance"}
          >
            <Palette size={16} />
            <span>Appearance</span>
          </button>
          <button
            type="button"
            className={`modal-tab-btn ${activeTab === "terminal" ? "active" : ""}`}
            onClick={() => setActiveTab("terminal")}
            role="tab"
            aria-selected={activeTab === "terminal"}
          >
            <Type size={16} />
            <span>Font & Display</span>
          </button>
          <button
            type="button"
            className={`modal-tab-btn ${activeTab === "shell" ? "active" : ""}`}
            onClick={() => setActiveTab("shell")}
            role="tab"
            aria-selected={activeTab === "shell"}
          >
            <Terminal size={16} />
            <span>Shell & Tools</span>
          </button>
          <button
            type="button"
            className={`modal-tab-btn ${activeTab === "shortcuts" ? "active" : ""}`}
            onClick={() => setActiveTab("shortcuts")}
            role="tab"
            aria-selected={activeTab === "shortcuts"}
          >
            <Keyboard size={16} />
            <span>Shortcuts</span>
          </button>
          <button
            type="button"
            className={`modal-tab-btn ${activeTab === "updates" ? "active" : ""}`}
            onClick={() => setActiveTab("updates")}
            role="tab"
            aria-selected={activeTab === "updates"}
          >
            <ArrowUpCircle size={16} />
            <span>Updates</span>
            {updateInfo?.updateAvailable && (
              <span className="toolbar-update-dot" aria-hidden="true" />
            )}
          </button>
        </div>

        <div className="modal-body">
          {/* 1. APPEARANCE TAB */}
          {activeTab === "appearance" && (
            <div className="settings-tab-panel">
              <div className="setting-field">
                <label>Color Theme</label>
                <div className="theme-selector-grid">
                  {THEME_OPTIONS.map((theme) => {
                    const isSelected = formData.theme === theme.id;
                    return (
                      <button
                        key={theme.id}
                        type="button"
                        className={`theme-card ${isSelected ? "selected" : ""}`}
                        onClick={() => setFormData({ ...formData, theme: theme.id })}
                      >
                        <div className="theme-card-preview" style={{ backgroundColor: theme.bg }}>
                          <span className="preview-dot" style={{ backgroundColor: theme.accent }} />
                          <span className="preview-text" style={{ color: theme.fg }}>
                            &gt;_
                          </span>
                        </div>
                        <span className="theme-card-name">{theme.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="setting-field">
                <div className="label-with-value">
                  <label htmlFor="terminal-opacity-slider">Terminal Background Opacity</label>
                  <span className="slider-badge">{currentOpacityPercent}%</span>
                </div>
                <div className="slider-container">
                  <input
                    id="terminal-opacity-slider"
                    type="range"
                    className="slider-input"
                    min={20}
                    max={100}
                    step={1}
                    value={currentOpacityPercent}
                    onChange={(e) => {
                      const val = parseInt(e.target.value) / 100;
                      setFormData({ ...formData, opacity: val });
                    }}
                  />
                </div>
                <p className="muted-text">
                  Fades the terminal background and the window chrome so the desktop shows through.
                  {!windowTransparencySupported() &&
                    " On macOS (and in a browser) only the terminal background fades."}
                </p>
              </div>

              <div className="setting-row">
                <div className="setting-field">
                  <label htmlFor="cursor-style-select">Cursor Style</label>
                  <select
                    id="cursor-style-select"
                    className="select-input modal-input"
                    value={formData.cursorStyle || "block"}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        cursorStyle: e.target.value as CursorStyle,
                      })
                    }
                  >
                    <option value="block">Block</option>
                    <option value="underline">Underline</option>
                    <option value="bar">Bar (Vertical Line)</option>
                  </select>
                </div>

                <div className="setting-field checkbox-field" style={{ alignSelf: "flex-end" }}>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={formData.cursorBlink}
                      onChange={(e) => setFormData({ ...formData, cursorBlink: e.target.checked })}
                    />
                    <span>Cursor Blink</span>
                  </label>
                </div>
              </div>

              <div className="setting-field checkbox-field">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={Boolean(formData.showMusicPlayer)}
                    onChange={(e) =>
                      setFormData({ ...formData, showMusicPlayer: e.target.checked })
                    }
                  />
                  <span>YouTube music player</span>
                </label>
              </div>
            </div>
          )}

          {/* 2. FONT & DISPLAY TAB */}
          {activeTab === "terminal" && (
            <div className="settings-tab-panel">
              <div className="setting-field">
                <label htmlFor="font-preset-select">Font Family (System & Monospace)</label>
                <select
                  id="font-preset-select"
                  className="select-input modal-input"
                  value={selectedFontPreset}
                  onChange={(e) => handleFontPresetChange(e.target.value)}
                >
                  <optgroup label="System Monospace Fonts">
                    {FONT_PRESETS.slice(0, 6).map((font) => (
                      <option key={font.value} value={font.value}>
                        {font.label}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Popular Coding Fonts">
                    {FONT_PRESETS.slice(6).map((font) => (
                      <option key={font.value} value={font.value}>
                        {font.label}
                      </option>
                    ))}
                  </optgroup>
                  <option value="custom">Custom Font Name / Stack...</option>
                </select>
              </div>

              {selectedFontPreset === "custom" && (
                <div className="setting-field">
                  <label htmlFor="custom-font-input">Custom Font Family</label>
                  <input
                    id="custom-font-input"
                    type="text"
                    className="text-input modal-input"
                    value={formData.fontFamily}
                    onChange={(e) => setFormData({ ...formData, fontFamily: e.target.value })}
                    placeholder="e.g. Hack, 'Comic Mono', monospace"
                  />
                </div>
              )}

              <div className="setting-field">
                <label>Font Preview</label>
                <div
                  className="font-preview-box"
                  style={{
                    fontFamily: formData.fontFamily,
                    fontSize: `${formData.fontSize}px`,
                  }}
                >
                  The quick brown fox jumps over the lazy dog.
                  <br />
                  0123456789 &lt;= =&gt; === !== &amp;&amp; || -&gt;
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-field">
                  <label htmlFor="font-size-input">Font Size (px)</label>
                  <input
                    id="font-size-input"
                    type="number"
                    className="text-input modal-input"
                    min={8}
                    max={36}
                    value={formData.fontSize}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        fontSize: Math.max(8, Math.min(36, parseInt(e.target.value) || 12)),
                      })
                    }
                  />
                </div>

                <div className="setting-field">
                  <label htmlFor="scrollback-input">Scrollback Buffer (lines)</label>
                  <input
                    id="scrollback-input"
                    type="number"
                    className="text-input modal-input"
                    min={1000}
                    max={100000}
                    step={1000}
                    value={formData.scrollback}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        scrollback: Math.max(1000, parseInt(e.target.value) || 10000),
                      })
                    }
                  />
                </div>
              </div>
            </div>
          )}

          {/* 3. SHELL & TOOLS TAB */}
          {activeTab === "shell" && (
            <div className="settings-tab-panel">
              <div className="setting-field">
                <label htmlFor="default-shell-select">Default Shell Profile</label>
                <select
                  id="default-shell-select"
                  className="select-input modal-input"
                  value={formData.defaultShellId || ""}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      defaultShellId: e.target.value || undefined,
                    })
                  }
                >
                  <option value="">System Default</option>
                  {shells.map((shell) => (
                    <option key={shell.id} value={shell.id}>
                      {shell.name} {shell.is_wsl ? "(WSL)" : ""}
                    </option>
                  ))}
                </select>
                <p className="muted-text">
                  Choose the default shell profile activated when opening new sessions or tabs.
                </p>
              </div>

              <div className="setting-field">
                <label htmlFor="custom-shell-input">Custom Shell Executable Path (optional)</label>
                <input
                  id="custom-shell-input"
                  type="text"
                  className="text-input modal-input"
                  value={formData.customShellPath || ""}
                  onChange={(e) => setFormData({ ...formData, customShellPath: e.target.value })}
                  placeholder="e.g. /bin/bash or /bin/zsh"
                />
                <p className="muted-text">
                  Overrides the profile above when set. Validated locally; missing binaries show a
                  launch error instead of failing silently.
                </p>
              </div>

              <div className="setting-field">
                <label htmlFor="editor-preset-select">Default Code Editor</label>
                <select
                  id="editor-preset-select"
                  className="select-input modal-input"
                  value={selectedEditorPreset}
                  onChange={(e) => handleEditorPresetChange(e.target.value)}
                >
                  {EDITOR_PRESETS.map((editor) => (
                    <option key={editor.value} value={editor.value}>
                      {editor.label}
                    </option>
                  ))}
                </select>
                <p className="muted-text">
                  Configures which code editor opens when clicking the Editor icon or triggering the
                  shortcut.
                </p>
              </div>

              {selectedEditorPreset === "custom" && (
                <div className="setting-field">
                  <label htmlFor="editor-path-input">Custom Code Editor Executable Path</label>
                  <input
                    id="editor-path-input"
                    type="text"
                    className="text-input modal-input"
                    value={formData.editorPath || ""}
                    onChange={(e) => setFormData({ ...formData, editorPath: e.target.value })}
                    placeholder="e.g. code, cursor, /usr/bin/vscodium, hx"
                  />
                  <p className="muted-text">
                    Executable used to open project directories. Validated safely without shell
                    string interpolation.
                  </p>
                </div>
              )}

              <div className="setting-field checkbox-field">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={Boolean(formData.skipShellProfile)}
                    onChange={(e) =>
                      setFormData({ ...formData, skipShellProfile: e.target.checked })
                    }
                  />
                  <span>Skip shell profile scripts (faster launch)</span>
                </label>
                <p className="muted-text">
                  Adds -NoProfile for PowerShell/pwsh so new tabs skip $PROFILE scripts (prompt
                  themes, conda init). Prompt customizations and aliases stop loading while on.
                  Other shells are unaffected. Applies to new sessions.
                </p>
              </div>

              <div className="setting-field checkbox-field">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={Boolean(formData.launchAtStartup)}
                    onChange={(e) =>
                      setFormData({ ...formData, launchAtStartup: e.target.checked })
                    }
                  />
                  <span>Open Kai Terminal at startup</span>
                </label>
                <p className="muted-text">
                  Registers launch-at-login with the OS (Windows Run key, Linux XDG Autostart, macOS
                  LaunchAgent). Applies when you save settings.
                </p>
              </div>

              <div className="setting-field checkbox-field">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={Boolean(formData.autoRestoreSession)}
                    onChange={(e) =>
                      setFormData({ ...formData, autoRestoreSession: e.target.checked })
                    }
                  />
                  <span>Restore previous session automatically</span>
                </label>
                <p className="muted-text">
                  Off by default for a fast launch: Kai opens one fresh tab and offers a “Load
                  session” button instead of spawning every previous tab at startup.
                </p>
              </div>
            </div>
          )}

          {/* 4. KEYBOARD SHORTCUTS TAB */}
          {activeTab === "shortcuts" && (
            <div className="settings-tab-panel">
              <div className="setting-field">
                <div className="label-with-value">
                  <label>
                    Keyboard Shortcuts{" "}
                    <span className="muted-text">
                      (Click a field and press the key combination; Backspace clears it)
                    </span>
                  </label>
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    onClick={handleResetBindings}
                  >
                    <RotateCcw size={12} />
                    <span>Reset All to Defaults</span>
                  </button>
                </div>

                {bindingGroups.map(({ heading, actions }) => (
                  <div key={heading ?? "actions"} style={{ marginTop: heading ? "16px" : 0 }}>
                    {heading && <label style={{ display: "block" }}>{heading}</label>}
                    <div className="shortcuts-table">
                      {actions.map((action) => {
                        const isRecording = recordingAction === action;
                        const placeholder = isFixedAction(action)
                          ? DEFAULT_FIXED_SHORTCUTS[action]
                          : DEFAULT_SETTINGS.keybindings[action];
                        return (
                          <div key={action} className="shortcut-row-item">
                            <span className="shortcut-label">{BINDING_LABELS[action]}</span>
                            <div className="shortcut-input-group">
                              <input
                                type="text"
                                className={`text-input modal-input shortcut-input ${
                                  isRecording ? "recording" : ""
                                }`}
                                value={isRecording ? "Press shortcut..." : bindingFor(action) || ""}
                                // A recorder, not a text box: typing here used to write
                                // "Press shortcut...x" into the binding.
                                readOnly
                                onKeyDown={(e) => handleShortcutKeyDown(action, e)}
                                onFocus={() => setRecordingAction(action)}
                                onBlur={() => {
                                  if (recordingAction === action) setRecordingAction(null);
                                }}
                                placeholder={placeholder}
                                aria-label={`${BINDING_LABELS[action]} shortcut`}
                              />
                              {(bindingErrors[action] ||
                                conflictedActions.has(action) ||
                                reservedFor.has(action)) && (
                                <p className="error-text" role="alert">
                                  {bindingErrors[action] ??
                                    (reservedFor.has(action)
                                      ? `${platformLabel(bindingFor(action), isMac)} is reserved for "${reservedFor.get(action)}".`
                                      : `Conflicts with another action (${platformLabel(
                                          bindingFor(action),
                                          isMac
                                        )}).`)}
                                </p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}

                {(conflicts.length > 0 || reservedConflicts.length > 0) && (
                  <p className="error-text" role="alert" style={{ marginTop: "8px" }}>
                    Conflicting shortcuts must be resolved before saving.
                  </p>
                )}

                <label style={{ marginTop: "16px", display: "block" }}>
                  Other built-in shortcuts{" "}
                  <span className="muted-text">(fixed, not remappable)</span>
                </label>
                <div className="shortcuts-table">
                  {FIXED_SHORTCUT_HELP.map((row) => (
                    <div key={row.keys} className="shortcut-row-item">
                      <span className="shortcut-label">{row.label}</span>
                      <kbd className="muted-text">
                        {isMac ? row.keys.replace(/Ctrl/g, "Cmd") : row.keys}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* 5. UPDATES TAB */}
          {activeTab === "updates" && (
            <div className="settings-tab-panel">
              <div className="setting-field">
                <label>Application Information</label>
                <div className="update-details-list">
                  <div className="update-detail-row">
                    <span className="update-detail-label">• Application:</span>
                    <span className="update-detail-value">
                      v{appVersion}
                      {updateInfo?.latestVersion &&
                        !updateInfo.updateAvailable &&
                        !updateInfo.error && <span className="update-latest-badge"> (latest)</span>}
                    </span>
                  </div>

                  <div className="update-detail-row">
                    <span className="update-detail-label">• Author:</span>
                    <span className="update-detail-value">
                      {updateInfo?.releaseAuthor || "surajthaqurie"}
                    </span>
                  </div>

                  <div className="update-detail-row">
                    <span className="update-detail-label">• Published:</span>
                    <span className="update-detail-value">
                      {updateInfo?.publishedAt && !updateInfo?.error
                        ? new Date(updateInfo.publishedAt).toLocaleDateString(undefined, {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          })
                        : "—"}
                    </span>
                  </div>

                  <div className="update-detail-row">
                    <span className="update-detail-label">• Status:</span>
                    <span className="update-detail-value">
                      {updateInfo?.updateAvailable && updateInfo.latestVersion ? (
                        <span className="update-available-text" role="status">
                          Update available: v{appVersion} → v{updateInfo.latestVersion}
                        </span>
                      ) : updateInfo && !updateInfo.error && updateInfo.latestVersion ? (
                        <span className="update-uptodate-text" role="status">
                          You&apos;re up to date — you are running the latest version.
                        </span>
                      ) : updateInfo?.error ? (
                        <span className="update-error-text" role="status">
                          Check failed: {updateInfo.error}
                        </span>
                      ) : (
                        <span className="muted-text">Not checked yet in this session.</span>
                      )}
                    </span>
                  </div>
                </div>
              </div>

              <div className="setting-field">
                <div className="footer-actions" style={{ justifyContent: "flex-start" }}>
                  <button
                    type="button"
                    className="btn btn-primary btn-small"
                    onClick={onCheckUpdates}
                    disabled={isCheckingUpdates || !onCheckUpdates}
                  >
                    <ArrowUpCircle size={14} />
                    <span>{isCheckingUpdates ? "Checking…" : "Check for Updates"}</span>
                  </button>
                  {updateInfo?.updateAvailable &&
                    updateInfo.latestVersion &&
                    updateInfo.selectedAsset &&
                    onDownloadAndInstall && (
                      <button
                        type="button"
                        className="btn btn-primary btn-small"
                        onClick={onDownloadAndInstall}
                        disabled={
                          updateDownload?.status === "downloading" ||
                          updateDownload?.status === "installing"
                        }
                        title={`Download ${updateInfo.selectedAssetLabel ?? "installer"} and install automatically`}
                      >
                        <Download size={14} />
                        <span>
                          {updateDownload?.status === "downloading"
                            ? `Downloading${updateDownload.progress != null ? ` ${Math.round(updateDownload.progress)}%` : "…"}`
                            : updateDownload?.status === "installing"
                              ? "Installing…"
                              : `Download & Install v${updateInfo.latestVersion}`}
                        </span>
                      </button>
                    )}
                  {updateInfo?.updateAvailable && updateInfo.latestVersion && onViewUpdate && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      onClick={onViewUpdate}
                      title={
                        updateInfo.selectedAsset
                          ? "Open the release page instead of auto-install"
                          : "Open the release page to download manually"
                      }
                    >
                      <ExternalLink size={14} />
                      <span>
                        {updateInfo.selectedAsset
                          ? "Release notes"
                          : `Update to v${updateInfo.latestVersion}`}
                      </span>
                    </button>
                  )}
                </div>
                {updateDownload &&
                  (updateDownload.status === "downloading" ||
                    updateDownload.status === "installing") && (
                    <div className="update-progress-row" role="status">
                      <UpdateProgressBar state={updateDownload} />
                      <span className="muted-text">{describeUpdateStep(updateDownload)}</span>
                    </div>
                  )}
                {updateInfo?.selectedAsset && updateDownload?.status !== "installing" && (
                  <p className="muted-text" role="status">
                    Detected installer for this device: {updateInfo.selectedAsset.name}
                    {updateInfo.selectedAssetLabel ? ` (${updateInfo.selectedAssetLabel})` : ""}.
                  </p>
                )}
                {updateDownload?.status === "error" && updateDownload.message && (
                  <p className="error-text" role="alert">
                    {updateDownload.message}
                  </p>
                )}
                {updateDownload?.status === "installed" && updateDownload.message && (
                  <p className="muted-text" role="status">
                    {updateDownload.message}
                  </p>
                )}
                <p className="muted-text">
                  Checks the public GitHub releases page for a newer version. When an installer is
                  available for your OS, Kai downloads it and installs it in the background, then
                  restarts by itself — otherwise use the release page.
                </p>
              </div>

              <div className="setting-field checkbox-field">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={formData.autoCheckUpdates ?? true}
                    onChange={(e) =>
                      setFormData({ ...formData, autoCheckUpdates: e.target.checked })
                    }
                  />
                  <span>Automatically check for updates</span>
                </label>
                <p className="muted-text">
                  When enabled, Kai checks once per day on startup and every few hours while open.
                  Applies when you save settings.
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={handleReset}>
            <RotateCcw size={14} />
            <span>Reset Defaults</span>
          </button>
          <div className="footer-actions">
            <button className="btn" onClick={handleCancel}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={handleSave} disabled={hasBindingErrors}>
              <Save size={14} />
              <span>Save Settings</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
