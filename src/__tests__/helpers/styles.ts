import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Repository root (tests run from it). */
export const ROOT = resolve(__dirname, "../../..");

/** The stylesheet entry the app imports (`src/main.tsx`). */
export const STYLES_ENTRY = resolve(ROOT, "src/styles/index.css");

/**
 * The whole app stylesheet as the bundler sees it: `@import`s inlined
 * depth-first in order, so the text and the cascade order match the build.
 * Tests that inspect CSS read this, never one file, so moving a rule between
 * files cannot hide it from a test.
 */
export function readStylesheet(entry: string = STYLES_ENTRY): string {
  const seen = new Set<string>();
  const inline = (file: string): string => {
    if (seen.has(file)) return "";
    seen.add(file);
    const text = readFileSync(file, "utf8");
    return text.replace(/^@import\s+"([^"]+)";\s*$/gm, (_, rel: string) =>
      inline(resolve(dirname(file), rel))
    );
  };
  return inline(entry);
}

/** Every stylesheet file reached from the entry, in import order. */
export function stylesheetFiles(entry: string = STYLES_ENTRY): string[] {
  const files: string[] = [];
  const walk = (file: string) => {
    if (files.includes(file)) return;
    files.push(file);
    for (const m of readFileSync(file, "utf8").matchAll(/^@import\s+"([^"]+)";\s*$/gm)) {
      walk(resolve(dirname(file), m[1]));
    }
  };
  walk(entry);
  return files;
}
