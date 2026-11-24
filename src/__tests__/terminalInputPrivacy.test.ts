import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Privacy regression (SEC-06): the terminal must never persist what the user
 * types. The previous implementation rebuilt "command lines" from raw `onData`
 * and wrote them to localStorage, which captured passphrases typed at no-echo
 * prompts and text typed into TUIs, in plaintext, for a feature nothing used.
 *
 * TerminalView is far too heavy to mount for this, so this guards the source
 * contract: no storage API is reachable from the keystroke path.
 */
const SRC = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");

describe("typed terminal input is never persisted", () => {
  it("TerminalView writes nothing to browser storage and does not use the old history store", () => {
    const source = read("components/TerminalView.tsx");
    // (It may READ the user-set `kai_renderer` override; it must never write.)
    expect(source).not.toMatch(/(localStorage|sessionStorage)\s*\.\s*setItem|indexedDB/);
    expect(source).not.toMatch(/kai_cmd_history|recordCommand|saveCommandHistory/);
    expect(source).not.toMatch(/services\/autocomplete/);
  });

  it("the history service is gone and nothing imports it", () => {
    expect(fs.existsSync(path.join(SRC, "services/autocomplete.ts"))).toBe(false);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name) && !full.endsWith("terminalInputPrivacy.test.ts")) {
          if (/services\/autocomplete["']/.test(fs.readFileSync(full, "utf8")))
            offenders.push(full);
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
