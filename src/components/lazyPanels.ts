import { lazy } from "react";

/**
 * On-demand UI is code-split out of the startup bundle: these panels and
 * modals open long after first paint (or never), so parsing them up front
 * only taxes WebView2 cold start on Windows. Each loads on first open; the
 * `import*` loaders double as prefetch entry points (single source of truth
 * for the module paths).
 */
const importCommandPalette = () => import("./CommandPalette");
const importSettingsModal = () => import("./SettingsModal");
const importAiCliPanel = () => import("./AiCliPanel");
const importDiagnosticsModal = () => import("./DiagnosticsModal");
const importMusicPanel = () => import("./MusicPlayer/MusicPanel");
const importWorkspaceModal = () => import("./WorkspaceModal");

export const CommandPalette = lazy(() =>
  importCommandPalette().then((m) => ({ default: m.CommandPalette }))
);
export const SettingsModal = lazy(() =>
  importSettingsModal().then((m) => ({ default: m.SettingsModal }))
);
export const AiCliPanel = lazy(() => importAiCliPanel().then((m) => ({ default: m.AiCliPanel })));
export const DiagnosticsModal = lazy(() =>
  importDiagnosticsModal().then((m) => ({ default: m.DiagnosticsModal }))
);
export const MusicPanel = lazy(() => importMusicPanel().then((m) => ({ default: m.MusicPanel })));
export const WorkspaceModal = lazy(() =>
  importWorkspaceModal().then((m) => ({ default: m.WorkspaceModal }))
);
export const GitStatusModal = lazy(() =>
  import("./GitStatusModal").then((m) => ({ default: m.GitStatusModal }))
);
export const GitChangesModal = lazy(() =>
  import("./GitChangesModal").then((m) => ({ default: m.GitChangesModal }))
);

const ignore = () => {};

/** Warms the chunks users open most so the first open is instant. */
export function prefetchPrimaryPanels() {
  void importCommandPalette().catch(ignore);
  void importSettingsModal().catch(ignore);
}

/** Heavier panels, warmed a tick later so prefetch never contends with PTY spawn. */
export function prefetchSecondaryPanels() {
  void importAiCliPanel().catch(ignore);
  void importDiagnosticsModal().catch(ignore);
  void importWorkspaceModal().catch(ignore);
  // The YouTube Music drawer is lazy too: warm it so the first footer-pill
  // click opens the panel instantly instead of a beat later (which reads as
  // "the footer button does nothing").
  void importMusicPanel().catch(ignore);
}
