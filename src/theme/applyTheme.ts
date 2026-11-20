import { canvasColor, getTheme } from "./registry";

/**
 * Applies a theme to the document: the `data-theme` attribute every theme
 * stylesheet keys on, the native `color-scheme` (form controls, scrollbars) and
 * the browser `theme-color`. The one place this happens after first paint
 * (the boot script in index.html does the same before React mounts).
 */
export function applyThemeToDocument(themeId: string): void {
  const theme = getTheme(themeId);
  document.documentElement.setAttribute("data-theme", theme.id);
  document.body.setAttribute("data-theme", theme.id);
  document.documentElement.style.colorScheme = theme.colorScheme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", canvasColor(theme));
}
