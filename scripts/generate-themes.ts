/**
 * Writes every file derived from the theme registry:
 *   src/styles/themes/<id>.css, src/styles/themes/index.css, index.html first paint.
 *
 * Run: npm run themes:generate   (Node >= 22.18 strips the TypeScript types itself)
 * `src/__tests__/themeRegistry.test.ts` fails when the committed output is stale.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { THEMES, DEFAULT_THEME_ID } from "../src/theme/registry.ts";
import { themeCss, themesIndexCss, withFirstPaint } from "../src/theme/generate.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const themesDir = resolve(root, "src/styles/themes");
mkdirSync(themesDir, { recursive: true });

for (const theme of THEMES) {
  writeFileSync(resolve(themesDir, `${theme.id}.css`), themeCss(theme, theme.id === DEFAULT_THEME_ID));
}
writeFileSync(resolve(themesDir, "index.css"), themesIndexCss(THEMES));

const htmlPath = resolve(root, "index.html");
writeFileSync(htmlPath, withFirstPaint(readFileSync(htmlPath, "utf8"), THEMES, DEFAULT_THEME_ID));

console.log(`Generated ${THEMES.length} themes.`);
