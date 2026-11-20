import type { ThemeDefinition } from "./registry";

/**
 * Pure generators for the files derived from the theme registry. Kept free of
 * runtime imports so `scripts/generate-themes.ts` can run under plain Node, and
 * `themeRegistry.test.ts` can regenerate in memory and compare with what is
 * committed. Output is already Prettier-formatted.
 */

/** Tab colours, inlined here (not imported) so this module has no runtime imports. */
function tabColorDeclarations(theme: ThemeDefinition): Array<[string, string]> {
  const t = theme.terminal;
  return [
    ["tab-color-blue", t.blue],
    ["tab-color-green", t.green],
    ["tab-color-yellow", t.yellow],
    ["tab-color-red", t.red],
    ["tab-color-purple", t.magenta],
    ["tab-color-teal", t.cyan],
    ["tab-color-orange", theme.orange],
    ["tab-color-gray", t.brightBlack],
  ];
}

function chevronUrl(stroke: string): string {
  const color = stroke.replace("#", "%23");
  return (
    `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' ` +
    `viewBox='0 0 24 24' fill='none' stroke='${color}' stroke-width='2' stroke-linecap='round' ` +
    `stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`
  );
}

export const GENERATED_HEADER =
  "/* GENERATED from src/theme/registry.ts by `npm run themes:generate`. Do not edit. */";

/** One theme's stylesheet: colour tokens only. The default theme also owns `:root`. */
export function themeCss(theme: ThemeDefinition, isDefault: boolean): string {
  const selector = isDefault ? `:root,\n[data-theme="${theme.id}"]` : `[data-theme="${theme.id}"]`;
  const lines = [
    `  color-scheme: ${theme.colorScheme};`,
    "",
    ...Object.entries(theme.chrome).map(([k, v]) => `  --${k}: ${v};`),
    "",
    ...tabColorDeclarations(theme).map(([k, v]) => `  --${k}: ${v};`),
    "",
    `  --select-chevron: ${chevronUrl(theme.chevron)};`,
  ];
  return `${GENERATED_HEADER}\n\n/* ${theme.name} */\n${selector} {\n${lines.join("\n")}\n}\n`;
}

/** `@import` list for every theme, in registry order. */
export function themesIndexCss(themes: ReadonlyArray<ThemeDefinition>): string {
  return (
    `${GENERATED_HEADER}\n\n` + themes.map((t) => `@import "./${t.id}.css";`).join("\n") + "\n"
  );
}

export const FIRST_PAINT_BEGIN = "<!-- theme:first-paint:begin -->";
export const FIRST_PAINT_END = "<!-- theme:first-paint:end -->";

/**
 * The `index.html` block painted before any script or stylesheet loads, so the
 * window never shows a blank frame, followed by the boot script that applies
 * the saved theme before React mounts.
 */
export function firstPaintBlock(themes: ReadonlyArray<ThemeDefinition>, defaultId: string): string {
  const def = themes.find((t) => t.id === defaultId);
  if (!def) throw new Error(`default theme ${defaultId} is not in the registry`);
  const style = [
    `      html { background: ${def.chrome["bg-canvas"]}; }`,
    ...themes
      .filter((t) => t.id !== defaultId)
      .map((t) => `      html[data-theme="${t.id}"] { background: ${t.chrome["bg-canvas"]}; }`),
  ].join("\n");
  const map = themes
    .map((t) => `          "${t.id}": ["${t.chrome["bg-canvas"]}", "${t.colorScheme}"],`)
    .join("\n");
  return `${FIRST_PAINT_BEGIN}
    <style>
      /* Painted before any script or stylesheet loads, so the window never shows a
         blank frame while the app starts. GENERATED from src/theme/registry.ts. */
${style}
    </style>
    <script>
      (function () {
        // Theme id -> [canvas colour, color-scheme]. GENERATED from src/theme/registry.ts.
        var themes = {
${map}
        };
        try {
          var raw =
            localStorage.getItem("kai_user_settings") ||
            localStorage.getItem("terminal_user_settings");
          if (raw) {
            var s = JSON.parse(raw);
            if (s && s.theme) {
              // A removed theme (e.g. "kali") falls back to the default.
              var theme = themes.hasOwnProperty(s.theme) ? s.theme : "${defaultId}";
              document.documentElement.setAttribute("data-theme", theme);
              document.documentElement.style.colorScheme = themes[theme][1];
              var m = document.querySelector('meta[name="theme-color"]');
              if (m) m.setAttribute("content", themes[theme][0]);
            }
            // See-through window (Windows / Linux desktop app): apply the saved
            // opacity before first paint so the chrome never flashes opaque.
            var op = s && typeof s.opacity === "number" ? s.opacity : 1;
            var desktop = "__TAURI_INTERNALS__" in window && !/mac/i.test(navigator.platform);
            if (desktop && op < 1) {
              document.documentElement.style.setProperty(
                "--win-alpha",
                String(Math.max(0.2, Math.min(1, op)))
              );
              document.documentElement.classList.add("win-translucent");
            }
          }
        } catch (_) {}
      })();
    </script>
    ${FIRST_PAINT_END}`;
}

/** `html` with its first-paint block replaced by a freshly generated one. */
export function withFirstPaint(
  html: string,
  themes: ReadonlyArray<ThemeDefinition>,
  defaultId: string
): string {
  const start = html.indexOf(FIRST_PAINT_BEGIN);
  const end = html.indexOf(FIRST_PAINT_END);
  if (start < 0 || end < start) throw new Error("index.html has no theme first-paint markers");
  return (
    html.slice(0, start) +
    firstPaintBlock(themes, defaultId) +
    html.slice(end + FIRST_PAINT_END.length)
  );
}
