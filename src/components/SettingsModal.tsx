import { FC, useState, useEffect } from "react";
import { UserSettings, ShellProfile, ThemeName, KeybindingsConfig } from "../types/terminal";
import { DEFAULT_SETTINGS, SettingsService } from "../services/settingsService";
import {
  SHORTCUT_ACTION_LABELS,
  ShortcutActionId,
  findConflicts,
  validateBinding,
  isMacPlatform,
  platformLabel,
} from "../services/shortcuts";
import { X, Save, RotateCcw } from "lucide-react";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: UserSettings;
  onSaveSettings: (newSettings: UserSettings) => void;
  shells: ShellProfile[];
}

export const SettingsModal: FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSaveSettings,
  shells,
}) => {
  const [formData, setFormData] = useState<UserSettings>(settings);
  const [bindingErrors, setBindingErrors] = useState<Record<string, string>>({});
  const isMac = isMacPlatform();

  useEffect(() => {
    setFormData(settings);
    setBindingErrors({});
  }, [settings, isOpen]);

  if (!isOpen) return null;

  const conflicts = findConflicts(formData.keybindings);
  const conflictedActions = new Set(conflicts.flatMap((c) => c.actions));

  const handleBindingChange = (action: ShortcutActionId, value: string) => {
    const next: KeybindingsConfig = {
      ...formData.keybindings,
      [action]: value,
    };
    setFormData({ ...formData, keybindings: next });
    const err = validateBinding(value);
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
    });
    setBindingErrors({});
  };

  const hasBindingErrors = Object.keys(bindingErrors).length > 0 || conflicts.length > 0;

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
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Terminal Settings</h3>
          <button className="btn-close" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          <div className="setting-field">
            <label>Color Theme</label>
            <select
              className="select-input modal-input"
              value={formData.theme}
              onChange={(e) => setFormData({ ...formData, theme: e.target.value as ThemeName })}
            >
              <option value="catppuccin-mocha">Catppuccin Mocha</option>
              <option value="one-dark">One Dark</option>
              <option value="dracula">Dracula</option>
              <option value="solarized-dark">Solarized Dark</option>
              <option value="solarized-light">Solarized Light</option>
            </select>
          </div>

          <div className="setting-field">
            <label>Default Shell Profile</label>
            <select
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
          </div>

          <div className="setting-field">
            <label>Font Family</label>
            <input
              type="text"
              className="text-input modal-input"
              value={formData.fontFamily}
              onChange={(e) => setFormData({ ...formData, fontFamily: e.target.value })}
              placeholder="e.g. Menlo, Monaco, 'Courier New', monospace"
            />
          </div>

          <div className="setting-row">
            <div className="setting-field">
              <label>Font Size (px)</label>
              <input
                type="number"
                className="text-input modal-input"
                min={8}
                max={36}
                value={formData.fontSize}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    fontSize: Math.max(8, Math.min(36, parseInt(e.target.value) || 14)),
                  })
                }
              />
            </div>

            <div className="setting-field">
              <label>Scrollback Lines</label>
              <input
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

          <div className="setting-field">
            <label>Custom Shell Executable Path (optional)</label>
            <input
              type="text"
              className="text-input modal-input"
              value={formData.customShellPath || ""}
              onChange={(e) => setFormData({ ...formData, customShellPath: e.target.value })}
              placeholder="e.g. /bin/bash (validated on launch)"
            />
            <p className="muted-text">
              Overrides the profile above when set. Validated locally; missing binaries show a
              launch error instead of failing silently.
            </p>
          </div>

          <div className="setting-field">
            <label>Code Editor Executable Path (optional)</label>
            <input
              type="text"
              className="text-input modal-input"
              value={formData.editorPath || ""}
              onChange={(e) => setFormData({ ...formData, editorPath: e.target.value })}
              placeholder="e.g. code, cursor, /usr/bin/vscodium"
            />
            <p className="muted-text">
              Executable used to open project directories. Validated safely without shell string
              interpolation.
            </p>
          </div>

          <div className="setting-field checkbox-field">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={formData.cursorBlink}
                onChange={(e) => setFormData({ ...formData, cursorBlink: e.target.checked })}
              />
              <span>Cursor Blink</span>
            </label>
          </div>

          <div className="setting-field">
            <label>
              Keyboard Shortcuts{" "}
              <span className="muted-text">
                ({isMac ? "Cmd" : "Ctrl"}-based; changes apply after save)
              </span>
            </label>
            {(Object.keys(SHORTCUT_ACTION_LABELS) as ShortcutActionId[]).map((action) => (
              <div key={action} className="setting-row shortcut-row">
                <span className="shortcut-label">{SHORTCUT_ACTION_LABELS[action]}</span>
                <input
                  type="text"
                  className="text-input modal-input shortcut-input"
                  value={formData.keybindings[action]}
                  onChange={(e) => handleBindingChange(action, e.target.value)}
                  placeholder={DEFAULT_SETTINGS.keybindings[action]}
                  aria-label={`${SHORTCUT_ACTION_LABELS[action]} shortcut`}
                />
                {(bindingErrors[action] || conflictedActions.has(action)) && (
                  <p className="error-text" role="alert">
                    {bindingErrors[action] ??
                      `Conflicts with another action (${platformLabel(formData.keybindings[action], isMac)}).`}
                  </p>
                )}
              </div>
            ))}
            {conflicts.length > 0 && (
              <p className="error-text" role="alert">
                Conflicting shortcuts must be resolved before saving.
              </p>
            )}
            <button type="button" className="btn btn-secondary" onClick={handleResetBindings}>
              <RotateCcw size={14} />
              <span>Reset shortcuts to defaults</span>
            </button>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={handleReset}>
            <RotateCcw size={14} />
            <span>Reset Defaults</span>
          </button>
          <div className="footer-actions">
            <button className="btn" onClick={onClose}>
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
