import type { IndexedDependency, IndexedSymbol } from "./types";

/**
 * Deterministic, non-evaluating symbol and import extractor for TypeScript /
 * JavaScript, Rust, Python and Go.
 *
 * This is a TEXT-BASED scanner, not a parser and not an AST. Each file is first
 * lexed just enough to blank out comments, string/template/regex literals and
 * (for Python) docstrings, so braces and keywords inside them cannot confuse
 * the scan. Declarations are then recognised with anchored patterns at
 * statement starts while brace depth (or, for Python, indentation) tracks the
 * enclosing scope. Consequences:
 *
 *  - Only module-level declarations and class / impl / trait / namespace
 *    members are indexed; locals inside function bodies never are.
 *  - Wrapped (multi-line) signatures are supported; `line` is the first line
 *    of the declaration and `endLine` the line of its closing brace (or the end
 *    of the statement / indented block). `endLine` is omitted when the closing
 *    delimiter cannot be found (malformed or truncated source).
 *  - It is heuristic: unusual formatting, macros, and regex-vs-division
 *    ambiguities can still be mis-scanned. Malformed input never throws.
 *  - Lines longer than MAX_LINE_CHARS (minified bundles) are ignored.
 *
 * Bump EXTRACTOR_VERSION whenever the output for the same input changes; stored
 * indexes carrying an older value are re-extracted on the next refresh.
 */
export const EXTRACTOR_VERSION = 7;

const MAX_LINE_CHARS = 2048;
const MAX_SYMBOLS_PER_FILE = 5000;
const MAX_SIGNATURE_CHARS = 240;
const MAX_HEADER_SCAN = 4000;

type Range = [number, number];
type SymbolKind = IndexedSymbol["kind"];

interface Extraction {
  symbols: IndexedSymbol[];
  dependencies: IndexedDependency[];
}

// ---------------------------------------------------------------------------
// Lexing: find comment and string ranges
// ---------------------------------------------------------------------------

interface Lexed {
  comments: Range[];
  strings: Range[];
}

const isIdentChar = (c: string | undefined): boolean => !!c && /[A-Za-z0-9_$]/.test(c);

/** Skip a quoted string starting at `i`; returns the index after it, or -1 when unterminated on this line. */
function skipLineString(text: string, i: number): number {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length) {
    const ch = text[j];
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === quote) return j + 1;
    if (ch === "\n") return -1;
    j++;
  }
  return -1;
}

/** Skip a JS template literal (with nested `${}`) starting at the backtick; returns the index after it. */
function skipTemplate(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length) {
    const ch = text[j];
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === "`") return j + 1;
    if (ch === "$" && text[j + 1] === "{") {
      j += 2;
      let depth = 1;
      while (j < text.length && depth > 0) {
        const c = text[j];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === "`") {
          j = skipTemplate(text, j);
          continue;
        } else if (c === '"' || c === "'") {
          const end = skipLineString(text, j);
          if (end > 0) {
            j = end;
            continue;
          }
        }
        j++;
      }
      continue;
    }
    j++;
  }
  return text.length;
}

const REGEX_PREV_CHARS = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", ";", "+", "-"]);
const REGEX_PREV_WORDS = new Set(["return", "typeof", "case", "in", "of", "delete", "void"]);

function lexJs(text: string): Lexed {
  const comments: Range[] = [];
  const strings: Range[] = [];
  const n = text.length;
  let i = 0;
  let prevSig = "";
  let prevWord = "";
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      const j = text.indexOf("\n", i);
      const end = j < 0 ? n : j;
      comments.push([i, end]);
      i = end;
      continue;
    }
    if (c === "/" && d === "*") {
      const j = text.indexOf("*/", i + 2);
      const end = j < 0 ? n : j + 2;
      comments.push([i, end]);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = skipLineString(text, i);
      if (end > 0) {
        strings.push([i, end]);
        i = end;
        prevSig = "s";
        prevWord = "";
        continue;
      }
      // Unterminated on this line (e.g. an apostrophe in JSX text): not a string.
      i++;
      continue;
    }
    if (c === "`") {
      const end = skipTemplate(text, i);
      strings.push([i, end]);
      i = end;
      prevSig = "s";
      prevWord = "";
      continue;
    }
    if (c === "/") {
      const regexAllowed =
        prevSig === "" || REGEX_PREV_CHARS.has(prevSig) || REGEX_PREV_WORDS.has(prevWord);
      if (regexAllowed) {
        let j = i + 1;
        let inClass = false;
        let closed = -1;
        while (j < n && text[j] !== "\n") {
          const ch = text[j];
          if (ch === "\\") {
            j += 2;
            continue;
          }
          if (ch === "[") inClass = true;
          else if (ch === "]") inClass = false;
          else if (ch === "/" && !inClass) {
            closed = j;
            break;
          }
          j++;
        }
        if (closed > i + 1) {
          let end = closed + 1;
          while (end < n && /[a-z]/.test(text[end])) end++;
          strings.push([i, end]);
          i = end;
          prevSig = "s";
          prevWord = "";
          continue;
        }
      }
      prevSig = "/";
      prevWord = "";
      i++;
      continue;
    }
    if (isIdentChar(c)) {
      let j = i + 1;
      while (j < n && isIdentChar(text[j])) j++;
      prevWord = text.slice(i, j);
      prevSig = "a";
      i = j;
      continue;
    }
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") {
      prevSig = c;
      prevWord = "";
    }
    i++;
  }
  return { comments, strings };
}

function lexRust(text: string): Lexed {
  const comments: Range[] = [];
  const strings: Range[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      const j = text.indexOf("\n", i);
      const end = j < 0 ? n : j;
      comments.push([i, end]);
      i = end;
      continue;
    }
    if (c === "/" && d === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === "/" && text[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (text[j] === "*" && text[j + 1] === "/") {
          depth--;
          j += 2;
        } else j++;
      }
      comments.push([i, j]);
      i = j;
      continue;
    }
    if ((c === "r" || c === "b") && !isIdentChar(text[i - 1])) {
      const m = /^(?:br|r)(#*)"/.exec(text.slice(i, i + 40));
      if (m) {
        const closer = '"' + m[1];
        const bodyStart = i + m[0].length;
        const j = text.indexOf(closer, bodyStart);
        const end = j < 0 ? n : j + closer.length;
        strings.push([i, end]);
        i = end;
        continue;
      }
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      strings.push([i, Math.min(j, n)]);
      i = Math.min(j, n);
      continue;
    }
    if (c === "'") {
      // Char literal vs lifetime/label: `'a'` / `'\n'` are chars, `'a` is a lifetime.
      if (d === "\\") {
        const close = text.indexOf("'", i + 3);
        if (close > 0 && close - i <= 12) {
          strings.push([i, close + 1]);
          i = close + 1;
          continue;
        }
      } else if (d !== undefined && d !== "'" && text[i + 2] === "'") {
        strings.push([i, i + 3]);
        i += 3;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return { comments, strings };
}

function lexGo(text: string): Lexed {
  const comments: Range[] = [];
  const strings: Range[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      const j = text.indexOf("\n", i);
      const end = j < 0 ? n : j;
      comments.push([i, end]);
      i = end;
      continue;
    }
    if (c === "/" && d === "*") {
      const j = text.indexOf("*/", i + 2);
      const end = j < 0 ? n : j + 2;
      comments.push([i, end]);
      i = end;
      continue;
    }
    if (c === "`") {
      const j = text.indexOf("`", i + 1);
      const end = j < 0 ? n : j + 1;
      strings.push([i, end]);
      i = end;
      continue;
    }
    if (c === '"') {
      const end = skipLineString(text, i);
      if (end > 0) {
        strings.push([i, end]);
        i = end;
        continue;
      }
      i++;
      continue;
    }
    if (c === "'") {
      const close = d === "\\" ? text.indexOf("'", i + 3) : text.indexOf("'", i + 2);
      if (close > 0 && close - i <= 12 && !text.slice(i, close).includes("\n")) {
        strings.push([i, close + 1]);
        i = close + 1;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return { comments, strings };
}

function lexPython(text: string): Lexed {
  const comments: Range[] = [];
  const strings: Range[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === "#") {
      const j = text.indexOf("\n", i);
      const end = j < 0 ? n : j;
      comments.push([i, end]);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c + c + c, i);
      if (triple) {
        const closer = c + c + c;
        let j = i + 3;
        while (j < n) {
          if (text[j] === "\\") {
            j += 2;
            continue;
          }
          if (text.startsWith(closer, j)) {
            j += 3;
            break;
          }
          j++;
        }
        const end = Math.min(j, n);
        strings.push([i, end]);
        i = end;
        continue;
      }
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const ch = text[j];
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (ch === c) {
          closed = true;
          j++;
          break;
        }
        if (ch === "\n") break;
        j++;
      }
      if (closed) {
        strings.push([i, j]);
        i = j;
      } else {
        i++;
      }
      continue;
    }
    i++;
  }
  return { comments, strings };
}

/** Replace `ranges` with spaces, preserving newlines so offsets and line numbers are unchanged. */
function blank(text: string, ranges: Range[]): string {
  if (ranges.length === 0) return text;
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
  const out: string[] = [];
  let pos = 0;
  for (const [s, e] of sorted) {
    if (e <= pos) continue;
    const start = Math.max(s, pos);
    out.push(text.slice(pos, start));
    out.push(text.slice(start, e).replace(/[^\r\n]/g, " "));
    pos = e;
  }
  out.push(text.slice(pos));
  return out.join("");
}

// ---------------------------------------------------------------------------
// Shared scanner state
// ---------------------------------------------------------------------------

class Source {
  readonly lineStarts: number[] = [0];
  /** Comments, strings and regex literals blanked. */
  readonly code: string;
  /** Only comments blanked (string contents kept; used to read import specifiers). */
  readonly noComments: string;
  private readonly closeOf = new Map<number, number>();

  constructor(
    readonly text: string,
    lex: (t: string) => Lexed
  ) {
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
    const lexed = lex(text);
    this.noComments = blank(text, lexed.comments);
    this.code = blank(text, [...lexed.comments, ...lexed.strings]);
    this.computeBraces();
  }

  private computeBraces(): void {
    const stack: number[] = [];
    const code = this.code;
    for (let i = 0; i < code.length; i++) {
      const c = code.charCodeAt(i);
      if (c === 123) stack.push(i);
      else if (c === 125 && stack.length > 0) this.closeOf.set(stack.pop() as number, i);
    }
  }

  /** Index of the `}` matching the `{` at `open`, or -1. */
  matchClose(open: number): number {
    return this.closeOf.get(open) ?? -1;
  }

  /** 1-based line containing `offset`. */
  lineOf(offset: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  column(offset: number): number {
    return offset - this.lineStarts[this.lineOf(offset) - 1] + 1;
  }

  signature(from: number, to: number): string {
    const raw = this.text.slice(from, to).replace(/\s+/g, " ").trim();
    return raw.length > MAX_SIGNATURE_CHARS ? raw.slice(0, MAX_SIGNATURE_CHARS - 1) + "…" : raw;
  }
}

/** Blank over-long lines (minified code) in the raw text before lexing. */
function dropLongLines(content: string): string {
  if (content.length <= MAX_LINE_CHARS) return content;
  return content
    .split("\n")
    .map((l) => (l.length > MAX_LINE_CHARS ? "" : l))
    .join("\n");
}

class Collector {
  readonly symbols: IndexedSymbol[] = [];
  readonly deps: Array<{ at: number; dep: IndexedDependency }> = [];
  constructor(
    readonly src: Source,
    readonly relPath: string
  ) {}

  addSymbol(s: {
    name: string;
    kind: SymbolKind;
    at: number; // offset of the declaration start (line = first line of the declaration)
    nameAt: number;
    end?: number; // offset of the last character of the declaration
    signature?: string;
    exported: boolean;
    container?: string;
  }): void {
    if (this.symbols.length >= MAX_SYMBOLS_PER_FILE) return;
    const line = this.src.lineOf(s.at);
    const endLine = s.end !== undefined && s.end >= s.at ? this.src.lineOf(s.end) : undefined;
    const sym: IndexedSymbol = {
      name: s.name,
      kind: s.kind,
      filePath: this.relPath,
      location: {
        filePath: this.relPath,
        line,
        column: this.src.column(s.nameAt),
        ...(endLine !== undefined && endLine >= line ? { endLine } : {}),
      },
      ...(s.signature ? { signature: s.signature } : {}),
      isExported: s.exported,
      ...(s.container ? { container: s.container } : {}),
    };
    this.symbols.push(sym);
  }

  addDep(
    at: number,
    specifier: string,
    symbols: string[],
    isExternal: boolean,
    reExportedNames?: string[],
    importBindings?: Array<"default" | "namespace">
  ): void {
    if (!specifier) return;
    this.deps.push({
      at,
      dep: {
        sourceFile: this.relPath,
        targetSpecifier: specifier,
        isExternal,
        importedSymbols: symbols,
        ...(reExportedNames && reExportedNames.length > 0 ? { reExportedNames } : {}),
        ...(importBindings && importBindings.length > 0 ? { importBindings } : {}),
      },
    });
  }

  result(): Extraction {
    const dependencies = this.deps.sort((a, b) => a.at - b.at).map((d) => d.dep);
    return { symbols: this.symbols, dependencies };
  }
}

function sticky(re: RegExp, code: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(code);
}

function skipWs(code: string, i: number): number {
  while (i < code.length && /\s/.test(code[i])) i++;
  return i;
}

/** Index after the balanced `open..close` group that starts at `i` (code[i] === open); -1 when unbalanced. */
function skipBalanced(code: string, i: number, open: string, close: string): number {
  let depth = 0;
  const limit = Math.min(code.length, i + 200000);
  for (let j = i; j < limit; j++) {
    const c = code[j];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

/** Skip `<...>` generics (ignoring the `>` of `=>`); returns the index after it, or `i` when none. */
function skipAngles(code: string, i: number): number {
  const start = skipWs(code, i);
  if (code[start] !== "<") return i;
  let depth = 0;
  const limit = Math.min(code.length, start + MAX_HEADER_SCAN);
  for (let j = start; j < limit; j++) {
    const c = code[j];
    if (c === "<") depth++;
    else if (c === ">" && code[j - 1] !== "=") {
      depth--;
      if (depth === 0) return j + 1;
    } else if (c === ";" || c === "{" || c === "}") return i;
  }
  return i;
}

function prevSignificant(code: string, i: number): number {
  let j = i - 1;
  while (j >= 0 && /\s/.test(code[j])) j--;
  return j;
}

function lastNonSpace(code: string, from: number, to: number): number {
  let j = Math.min(to, code.length) - 1;
  while (j >= from && /\s/.test(code[j])) j--;
  return j;
}

// ---------------------------------------------------------------------------
// Block scanning shared by TypeScript/JavaScript and Rust
// ---------------------------------------------------------------------------

interface Scope {
  kind: "top" | "class" | "namespace" | "other";
  name?: string;
  exported?: boolean;
  traitImpl?: boolean;
  /** For `impl Trait for Type`: the trait's base name. */
  traitName?: string;
  /** For `impl Trait for Type`: the type's and the trait's path segments (empty when not a plain path). */
  typePath?: string[];
  traitPath?: string[];
  /** For an impl: it sits at the top level of the file, not inside an inline `mod { }`. */
  implAtTop?: boolean;
  isTrait?: boolean;
}

interface Pending {
  scope: Scope;
}

/**
 * Walk the blanked code tracking `{}` scopes and `()[]` depth. `detect` runs at
 * every statement start that is not inside parentheses and returns a pending
 * scope when the declaration it recognised opens a body that should be tracked.
 */
function scanBlocks(
  code: string,
  detect: (offset: number, scope: Scope) => Pending | undefined
): void {
  const scopes: Scope[] = [{ kind: "top" }];
  let paren = 0;
  let pending: Pending | null = null;
  let atStart = true;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "\n") {
      if (paren === 0) atStart = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") continue;
    const wasStart = atStart;
    atStart = false;
    if (wasStart && paren === 0 && !pending) {
      const scope = scopes[scopes.length - 1];
      if (scope.kind !== "other") {
        const found = detect(i, scope);
        if (found) pending = found;
      }
    }
    switch (c) {
      case "{":
        if (paren === 0 && pending) {
          scopes.push(pending.scope);
        } else {
          scopes.push({ kind: "other" });
        }
        pending = null;
        atStart = true;
        break;
      case "}":
        if (scopes.length > 1) scopes.pop();
        atStart = paren === 0;
        break;
      case ";":
        if (paren === 0) {
          pending = null;
          atStart = true;
        }
        break;
      case "(":
      case "[":
        paren++;
        break;
      case ")":
      case "]":
        paren = Math.max(0, paren - 1);
        break;
      default:
        break;
    }
  }
}

/** Find the first `{` at paren depth 0 from `from` (before any `;`); -1 when absent. */
function findBodyBrace(code: string, from: number): number {
  let paren = 0;
  const limit = Math.min(code.length, from + MAX_HEADER_SCAN);
  for (let i = from; i < limit; i++) {
    const c = code[i];
    if (c === "(" || c === "[") paren++;
    else if (c === ")" || c === "]") paren = Math.max(0, paren - 1);
    else if (paren === 0) {
      if (c === "{") return i;
      if (c === ";") return -1;
    }
  }
  return -1;
}

/**
 * End of a statement beginning at `from`: the `;` at nesting depth 0, or the
 * last character of the line where nesting returns to 0 and the next line does
 * not continue the expression. Returns the offset of the last statement char.
 */
function findStatementEnd(code: string, from: number): number {
  let depth = 0;
  const limit = Math.min(code.length, from + 400000);
  for (let i = from; i < limit; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth < 0) return lastNonSpace(code, from, i);
    } else if (c === ";" && depth === 0) return i;
    else if (c === "\n" && depth === 0) {
      const last = lastNonSpace(code, from, i);
      if (last < from) continue;
      // A line ending in an operator (or a trailing `=>`) continues the expression.
      if (/[=,+\-*/%&|?:!~^.]/.test(code[last])) continue;
      const next = skipWs(code, i);
      const nc = code[next];
      if (nc === undefined) return last;
      if (nc === "}" || nc === ")" || nc === "]") return last;
      if (/[.?:+\-*/%&|,=<>(\[`]/.test(nc)) continue;
      return last;
    }
  }
  return lastNonSpace(code, from, code.length);
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript
// ---------------------------------------------------------------------------

const RE_TS_FUNCTION =
  /(export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\b\s*\*?\s*([A-Za-z_$][\w$]*)/y;
const RE_TS_CLASS =
  /(export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/y;
const RE_TS_INTERFACE = /(export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/y;
const RE_TS_TYPE = /(export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)(?=\s*[<=])/y;
const RE_TS_ENUM = /(export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/y;
const RE_TS_NAMESPACE = /(export\s+)?(?:declare\s+)?(?:namespace|module)\s+([A-Za-z_$][\w$.]*)/y;
const RE_TS_VARIABLE =
  /(export\s+)?(?:declare\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)(?=\s*[:=;,]|\s*$)/y;
const RE_TS_EXPORT_LIST = /export\s+(?:type\s+)?\{/y;
const RE_TS_CJS = /(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=(?!=)/y;
const RE_TS_MEMBER_PREFIX =
  /(?:@[\w$.]+(?:\([^)\n]*\))?\s*)*((?:(?:public|private|protected|static|abstract|override|readonly|async|declare|accessor)\s+)*)/y;

/**
 * Index right after the params list `(...)` of a function-like header that
 * starts scanning at `afterName`, or -1.
 */
function paramsEnd(code: string, afterName: number): { open: number; close: number } | null {
  const i = skipAngles(code, afterName);
  const open = skipWs(code, i);
  if (code[open] !== "(") return null;
  const close = skipBalanced(code, open, "(", ")");
  return close < 0 ? null : { open, close };
}

/**
 * From just after a parameter list, find the function body `{` (skipping type
 * literals in the return type) or the terminating `;`.
 */
function findFunctionHeaderEnd(
  src: Source,
  from: number
): { body: number } | { semi: number } | { arrow: number } | null {
  const code = src.code;
  const limit = Math.min(code.length, from + MAX_HEADER_SCAN);
  let i = from;
  while (i < limit) {
    const c = code[i];
    if (c === "{") {
      const p = prevSignificant(code, i);
      const prev = code[p];
      const typeLiteral =
        prev === ":" ||
        prev === "|" ||
        prev === "&" ||
        prev === "<" ||
        prev === "," ||
        prev === "(" ||
        (prev === ">" && code[p - 1] === "=");
      if (typeLiteral) {
        const close = src.matchClose(i);
        if (close < 0) return null;
        i = close + 1;
        continue;
      }
      return { body: i };
    }
    if (c === ";") return { semi: i };
    if (c === "=" && code[i + 1] === ">") {
      // Arrow token after a parameter list: only meaningful for arrow functions.
      return { arrow: i };
    }
    if (c === "(" || c === "[") {
      const close = skipBalanced(code, i, c, c === "(" ? ")" : "]");
      if (close < 0) return null;
      i = close;
      continue;
    }
    if (c === "}") return null;
    i++;
  }
  return null;
}

/** End offset (last char) of a function-like whose params close at `afterParams`. */
function functionEnd(src: Source, afterParams: number): number | undefined {
  const header = findFunctionHeaderEnd(src, afterParams);
  if (!header) return undefined;
  if ("semi" in header) return header.semi;
  if ("arrow" in header) return undefined;
  const close = src.matchClose(header.body);
  return close < 0 ? undefined : close;
}

/**
 * Decide whether the value starting at `i` (after `=`) is a function:
 * `async? (…)[: T] =>`, `async? x =>`, `<T>(…) =>`, or `function`.
 */
function functionValue(
  src: Source,
  i: number
): { signatureEnd: number; end: number | undefined } | null {
  const code = src.code;
  let p = skipWs(code, i);
  const asyncM = /^async\b\s*/.exec(code.slice(p, p + 12));
  if (asyncM) p += asyncM[0].length;
  if (/^function\b/.test(code.slice(p, p + 9))) {
    const afterKw = p + "function".length;
    const nameM = /^\s*\*?\s*([A-Za-z_$][\w$]*)?/.exec(code.slice(afterKw, afterKw + 80));
    const pe = paramsEnd(code, afterKw + (nameM ? nameM[0].length : 0));
    if (!pe) return null;
    const header = findFunctionHeaderEnd(src, pe.close);
    if (!header || "arrow" in header) return null;
    if ("semi" in header) return { signatureEnd: header.semi, end: header.semi };
    const close = src.matchClose(header.body);
    return { signatureEnd: header.body, end: close < 0 ? undefined : close };
  }
  let afterParams = -1;
  const identArrow = /^[A-Za-z_$][\w$]*\s*=>/.exec(code.slice(p, p + 80));
  if (identArrow) {
    afterParams = p + identArrow[0].length - 2;
  } else {
    const pe = paramsEnd(code, p);
    if (!pe) return null;
    afterParams = pe.close;
  }
  // Optional `: ReturnType` then `=>`.
  const limit = Math.min(code.length, afterParams + MAX_HEADER_SCAN);
  let j = afterParams;
  let arrowAt = -1;
  while (j < limit) {
    const c = code[j];
    if (c === "=" && code[j + 1] === ">") {
      arrowAt = j;
      break;
    }
    if (c === ";" || c === "\n" || c === "=") {
      if (c === "\n") {
        // A wrapped return type may continue on the next line; only give up
        // when the next significant char cannot continue a type.
        const k = skipWs(code, j);
        if (/[A-Za-z_$|&<>{}()[\]:,.]/.test(code[k] ?? "") || code[k] === "=") {
          j++;
          continue;
        }
      }
      return null;
    }
    if (c === "(" || c === "[" || c === "{") {
      const close = skipBalanced(code, j, c, c === "(" ? ")" : c === "[" ? "]" : "}");
      if (close < 0) return null;
      j = close;
      continue;
    }
    j++;
  }
  if (arrowAt < 0) return null;
  const bodyStart = skipWs(code, arrowAt + 2);
  if (code[bodyStart] === "{") {
    const close = src.matchClose(bodyStart);
    return { signatureEnd: arrowAt + 2, end: close < 0 ? undefined : close };
  }
  return { signatureEnd: arrowAt + 2, end: findStatementEnd(code, bodyStart) };
}

/** Offset of the first top-level `=` (not `=>`, `==`, `<=`, `>=`, `!=`) from `i`, skipping a type annotation. */
function findAssignment(code: string, i: number): number {
  let depth = 0;
  const limit = Math.min(code.length, i + MAX_HEADER_SCAN);
  for (let j = i; j < limit; j++) {
    const c = code[j];
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ">" && code[j - 1] !== "=") depth--;
    else if (c === ";") return -1;
    else if (c === "\n" && depth <= 0) {
      // A type annotation may wrap, but a newline that cannot continue it ends the search.
      const last = lastNonSpace(code, i, j);
      const lastCh = code[last >= i ? last : prevSignificant(code, j)] ?? "";
      const nextCh = code[skipWs(code, j)] ?? "";
      if (!/[:|&,<=(]/.test(lastCh) && !/[|&=?]/.test(nextCh)) return -1;
    } else if (c === "=" && depth <= 0) {
      const next = code[j + 1];
      const prev = code[j - 1];
      if (
        next === ">" ||
        next === "=" ||
        prev === "=" ||
        prev === "!" ||
        prev === "<" ||
        prev === ">"
      ) {
        continue;
      }
      return j;
    }
    if (depth < 0) depth = 0;
  }
  return -1;
}

function extractTs(content: string, relPath: string): Extraction {
  const src = new Source(dropLongLines(content), lexJs);
  const out = new Collector(src, relPath);
  const code = src.code;
  const exportedNames = new Set<string>();

  scanBlocks(code, (p, scope) => {
    const inClass = scope.kind === "class";
    if (!inClass) {
      return detectTsStatement(src, out, p, scope, exportedNames);
    }
    detectTsMember(src, out, p, scope);
    return undefined;
  });

  collectTsImports(src, out);

  // `export { a, b as c }` and `export default name` mark top-level symbols exported.
  if (exportedNames.size > 0) {
    for (const s of out.symbols) {
      if (!s.container && exportedNames.has(s.name)) s.isExported = true;
    }
  }
  return out.result();
}

function detectTsStatement(
  src: Source,
  out: Collector,
  p: number,
  scope: Scope,
  exportedNames: Set<string>
): Pending | undefined {
  const code = src.code;
  const c = code[p];
  const container = scope.kind === "namespace" ? scope.name : undefined;

  // Fast reject: every declaration starts with a keyword, `@` or `module`/`exports`.
  if (!/[A-Za-z@]/.test(c)) return undefined;

  let m: RegExpExecArray | null;

  m = sticky(RE_TS_FUNCTION, code, p);
  if (m) {
    const name = m[2];
    const nameAt = p + m[0].length - name.length;
    const pe = paramsEnd(code, p + m[0].length);
    const end = pe ? functionEnd(src, pe.close) : undefined;
    let sigEnd = pe ? pe.close : p + m[0].length;
    if (pe) {
      const header = findFunctionHeaderEnd(src, pe.close);
      if (header && "body" in header) sigEnd = header.body;
      else if (header && "semi" in header) sigEnd = header.semi;
    }
    out.addSymbol({
      name,
      kind: "function",
      at: p,
      nameAt,
      end,
      signature: src.signature(p, sigEnd),
      exported: !!m[1],
      container,
    });
    return undefined;
  }

  m = sticky(RE_TS_CLASS, code, p);
  if (m) {
    const name = m[2];
    const nameAt = p + m[0].length - name.length;
    const body = findBodyBrace(code, p + m[0].length);
    const close = body >= 0 ? src.matchClose(body) : -1;
    out.addSymbol({
      name,
      kind: "class",
      at: p,
      nameAt,
      end: close >= 0 ? close : undefined,
      exported: !!m[1],
      container,
    });
    return { scope: { kind: "class", name, exported: !!m[1] } };
  }

  m = sticky(RE_TS_INTERFACE, code, p);
  if (m) {
    const name = m[2];
    const nameAt = p + m[0].length - name.length;
    const afterGenerics = skipAngles(code, p + m[0].length);
    const body = findBodyBrace(code, afterGenerics);
    const close = body >= 0 ? src.matchClose(body) : -1;
    out.addSymbol({
      name,
      kind: "interface",
      at: p,
      nameAt,
      end: close >= 0 ? close : undefined,
      exported: !!m[1],
      container,
    });
    return undefined;
  }

  m = sticky(RE_TS_TYPE, code, p);
  if (m) {
    const name = m[2];
    const nameAt = p + m[0].length - name.length;
    out.addSymbol({
      name,
      kind: "type",
      at: p,
      nameAt,
      end: findStatementEnd(code, p + m[0].length),
      exported: !!m[1],
      container,
    });
    return undefined;
  }

  m = sticky(RE_TS_ENUM, code, p);
  if (m) {
    const name = m[2];
    const nameAt = p + m[0].length - name.length;
    const body = findBodyBrace(code, p + m[0].length);
    const close = body >= 0 ? src.matchClose(body) : -1;
    out.addSymbol({
      name,
      kind: "type",
      at: p,
      nameAt,
      end: close >= 0 ? close : undefined,
      exported: !!m[1],
      container,
    });
    return undefined;
  }

  m = sticky(RE_TS_NAMESPACE, code, p);
  if (m) {
    const name = m[2];
    const nameAt = p + m[0].length - name.length;
    const body = findBodyBrace(code, p + m[0].length);
    const close = body >= 0 ? src.matchClose(body) : -1;
    out.addSymbol({
      name,
      kind: "module",
      at: p,
      nameAt,
      end: close >= 0 ? close : undefined,
      exported: !!m[1],
      container,
    });
    return { scope: { kind: "namespace", name, exported: !!m[1] } };
  }

  m = sticky(RE_TS_VARIABLE, code, p);
  if (m) {
    const name = m[3];
    const nameAt = p + m[0].length - name.length;
    const assign = findAssignment(code, p + m[0].length);
    let kind: SymbolKind = /^[A-Z0-9_]+$/.test(name) ? "constant" : "variable";
    let end: number | undefined;
    let sigEnd = Math.min(code.length, p + m[0].length);
    if (assign >= 0) {
      const fn = functionValue(src, assign + 1);
      if (fn) {
        kind = "function";
        end = fn.end;
        sigEnd = fn.signatureEnd;
      } else {
        end = findStatementEnd(code, assign + 1);
        sigEnd = Math.min(end + 1, nameAt + 120);
      }
    } else {
      end = findStatementEnd(code, p + m[0].length);
      sigEnd = Math.min(end + 1, nameAt + 120);
    }
    out.addSymbol({
      name,
      kind,
      at: p,
      nameAt,
      end,
      signature: src.signature(p, kind === "function" ? sigEnd : Math.min(sigEnd, p + 120)),
      exported: !!m[1],
      container,
    });
    return undefined;
  }

  m = sticky(RE_TS_CJS, code, p);
  if (m) {
    const name = m[1];
    const nameAt = p + m[0].lastIndexOf(name);
    const assign = p + m[0].length - 1;
    const fn = functionValue(src, assign + 1);
    out.addSymbol({
      name,
      kind: fn ? "function" : /^[A-Z0-9_]+$/.test(name) ? "constant" : "variable",
      at: p,
      nameAt,
      end: fn ? fn.end : findStatementEnd(code, assign + 1),
      signature: src.signature(p, fn ? fn.signatureEnd : Math.min(assign + 1, p + 120)),
      exported: true,
      container,
    });
    return undefined;
  }

  m = sticky(RE_TS_EXPORT_LIST, code, p);
  if (m) {
    const open = p + m[0].length - 1;
    const close = src.matchClose(open);
    if (close > open) {
      for (const part of code.slice(open + 1, close).split(",")) {
        const name = part
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]
          .trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) exportedNames.add(name);
      }
    }
    return undefined;
  }

  if (code.startsWith("export", p)) {
    const rest = code.slice(p, p + 200);
    const dm = /^export\s+default\s+([A-Za-z_$][\w$]*)\s*(?:;|\n|$)/.exec(rest);
    if (dm && !/^(?:async|function|class|abstract|interface)$/.test(dm[1])) {
      exportedNames.add(dm[1]);
    }
  }
  return undefined;
}

const RE_TS_PARAM_PROPERTY =
  /(?:@[\w$.]+(?:\([^)\n]*\))?\s*)*((?:(?:public|private|protected|readonly|override)\s+)+)([A-Za-z_$][\w$]*)/y;

/** Offsets of the top-level parameters between `open` `(` and `close` (index after `)`). */
function splitParameters(code: string, open: number, close: number): Array<[number, number]> {
  const parts: Array<[number, number]> = [];
  let depth = 0;
  let start = open + 1;
  const end = close - 1;
  for (let i = start; i < end; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === "<") {
      if (/[\w$]/.test(code[i - 1] ?? "")) depth++; // `Map<K, V>`, not `a < b`
    } else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if (c === ">") {
      if (code[i - 1] !== "=" && depth > 0) depth--; // `=>` is not a closing bracket
    } else if (c === "," && depth === 0) {
      parts.push([start, i]);
      start = i + 1;
    }
  }
  parts.push([start, end]);
  return parts;
}

function addParameterProperties(
  src: Source,
  out: Collector,
  open: number,
  close: number,
  scope: Scope
): void {
  const code = src.code;
  for (const [from, to] of splitParameters(code, open, close)) {
    const at = skipWs(code, from);
    if (at >= to) continue;
    const m = sticky(RE_TS_PARAM_PROPERTY, code, at);
    if (!m || at + m[0].length > to) continue;
    const modifiers = m[1];
    const hidden = /\b(?:private|protected)\b/.test(modifiers);
    out.addSymbol({
      name: m[2],
      kind: "variable",
      at,
      nameAt: at + m[0].length - m[2].length,
      end: lastNonSpace(code, at, to),
      signature: src.signature(at, to),
      exported: scope.exported === true && !hidden,
      container: scope.name,
    });
  }
}

function detectTsMember(src: Source, out: Collector, p: number, scope: Scope): void {
  const code = src.code;
  if (!/[A-Za-z_$#@*]/.test(code[p])) return;
  const prefix = sticky(RE_TS_MEMBER_PREFIX, code, p);
  if (!prefix) return;
  const modifiers = prefix[1] || "";
  let i = p + prefix[0].length;
  const accessorM = /^(?:get|set)\s+(?=[\w$#])/.exec(code.slice(i, i + 8));
  if (accessorM) i += accessorM[0].length;
  const genM = /^\*\s*/.exec(code.slice(i, i + 4));
  if (genM) i += genM[0].length;
  const nameM = /^[A-Za-z_$#][\w$]*/.exec(code.slice(i, i + 120));
  if (!nameM) return;
  const name = nameM[0];
  const nameAt = i;
  let after = skipWs(code, i + name.length);
  if (code[after] === "?" || code[after] === "!") after = skipWs(code, after + 1);

  const isPrivate = /\bprivate\b/.test(modifiers) || name.startsWith("#");
  const isProtected = /\bprotected\b/.test(modifiers);
  const exported = scope.exported === true && !isPrivate && !isProtected;

  // Method: name[<T>](...) {...}
  const pe = paramsEnd(code, after);
  if (pe && (code[after] === "(" || code[after] === "<")) {
    const header = findFunctionHeaderEnd(src, pe.close);
    let end: number | undefined;
    let sigEnd = pe.close;
    if (header && "body" in header) {
      const close = src.matchClose(header.body);
      end = close < 0 ? undefined : close;
      sigEnd = header.body;
    } else if (header && "semi" in header) {
      end = header.semi;
      sigEnd = header.semi;
    }
    out.addSymbol({
      name,
      kind: "function",
      at: p,
      nameAt,
      end,
      signature: src.signature(p, sigEnd),
      exported,
      container: scope.name,
    });
    // `constructor(private x: T, public readonly y = 1)` declares properties; only the
    // implementation (which has a body) does, not an overload signature.
    if (name === "constructor" && header && "body" in header) {
      addParameterProperties(src, out, pe.open, pe.close, scope);
    }
    return;
  }

  // Property holding a function: name = (…) => …  /  name: T = function …
  if (code[after] === "=" || code[after] === ":") {
    const assign = findAssignment(code, after);
    if (assign >= 0) {
      const fn = functionValue(src, assign + 1);
      if (fn) {
        out.addSymbol({
          name,
          kind: "function",
          at: p,
          nameAt,
          end: fn.end,
          signature: src.signature(p, fn.signatureEnd),
          exported,
          container: scope.name,
        });
        return;
      }
    }
  } else if (code[after] !== ";") {
    return;
  }

  // Plain property declaration: `name: T;`, `static readonly MAX = 3;`, `count;`. Private
  // ones (`private`, `#x`) are indexed too, never exported; the rest follow the class's visibility.
  const end = findStatementEnd(code, i + name.length);
  out.addSymbol({
    name,
    kind:
      /^[A-Z0-9_]+$/.test(name) && /\b(?:static|readonly)\b/.test(modifiers)
        ? "constant"
        : "variable",
    at: p,
    nameAt,
    end,
    signature: src.signature(p, Math.min(end + 1, nameAt + 120)),
    exported,
    container: scope.name,
  });
}

interface ImportHit {
  at: number;
  specifier: string;
  symbols: string[];
  /** Names a `export ... from` statement exports (`*` for a star export). */
  reExported?: string[];
  /** Default / namespace bindings of an `import ... from` statement. */
  bindings?: Array<"default" | "namespace">;
}

/** Exported names of an `export { a as b, type c } from` / `export * [as ns] from` clause. */
function parseReExportClause(clause: string): string[] {
  const t = clause.trim();
  if (t.startsWith("*")) {
    const ns = /^\*\s+as\s+([\w$]+)/.exec(t);
    return [ns ? ns[1] : "*"];
  }
  const names: string[] = [];
  const braces = /\{([^}]*)\}/.exec(t);
  if (braces) {
    for (const part of braces[1].split(",")) {
      const bits = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/);
      const exported = (bits[1] ?? bits[0]).trim();
      if (exported) names.push(exported);
    }
  }
  return names;
}

function parseImportClause(clause: string): string[] {
  const names: string[] = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces) {
    for (const part of braces[1].split(",")) {
      const n = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        .trim();
      if (n) names.push(n);
    }
  }
  const rest = clause.replace(/\{[^}]*\}/, "");
  for (const part of rest.split(",")) {
    const t = part.trim().replace(/^type\s+/, "");
    if (!t) continue;
    const ns = /^\*\s+as\s+([\w$]+)/.exec(t);
    if (ns) names.push(ns[1]);
    else if (/^[A-Za-z_$][\w$]*$/.test(t)) names.push(t);
  }
  return names;
}

/** Whether an import clause binds a default (`X`, `X, { y }`) and/or a namespace (`* as ns`). */
function parseImportBindings(clause: string): Array<"default" | "namespace"> {
  const out: Array<"default" | "namespace"> = [];
  for (const part of clause.replace(/\{[^}]*\}/, "").split(",")) {
    const t = part.trim().replace(/^type\s+/, "");
    if (!t) continue;
    if (/^\*\s+as\s+[\w$]+/.test(t)) out.push("namespace");
    else if (/^[A-Za-z_$][\w$]*$/.test(t)) out.push("default");
  }
  return out;
}

function collectTsImports(src: Source, out: Collector): void {
  const text = src.noComments;
  const code = src.code;
  const hits: ImportHit[] = [];
  // A keyword that survives in the fully blanked text is real code, not inside a string/regex.
  const real = (at: number, kw: string): boolean => code.startsWith(kw, at);

  // Every clause pattern below is length-bounded and stops at the next import /
  // export keyword. Unbounded `[^;]*`-style spans made a file of many unterminated
  // statements quadratic (tens of seconds at 512 KB), and the work runs under the
  // project lock.
  const importFrom =
    /\bimport\s+(?:type\s+)?((?:(?!\b(?:import|export)\b)[^'"`;]){0,4000}?)\s*\bfrom\s*(['"])([^'"\n]+)\2/g;
  for (let m = importFrom.exec(text); m; m = importFrom.exec(text)) {
    if (!real(m.index, "import")) continue;
    hits.push({
      at: m.index,
      specifier: m[3],
      symbols: parseImportClause(m[1]),
      bindings: parseImportBindings(m[1]),
    });
  }
  const sideEffect = /\bimport\s*(['"])([^'"\n]+)\1/g;
  for (let m = sideEffect.exec(text); m; m = sideEffect.exec(text)) {
    if (!real(m.index, "import")) continue;
    hits.push({ at: m.index, specifier: m[2], symbols: [] });
  }
  const exportFrom =
    /\bexport\s+(?:type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{(?:(?!\bexport\b)[^}]){0,3000}\})\s*from\s*(['"])([^'"\n]+)\2/g;
  for (let m = exportFrom.exec(text); m; m = exportFrom.exec(text)) {
    if (!real(m.index, "export")) continue;
    hits.push({
      at: m.index,
      specifier: m[3],
      symbols: parseImportClause(m[1]),
      reExported: parseReExportClause(m[1]),
    });
  }
  const dynamic = /\b(?:import|require)\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
  for (let m = dynamic.exec(text); m; m = dynamic.exec(text)) {
    if (!real(m.index, m[0].startsWith("import") ? "import" : "require")) continue;
    hits.push({ at: m.index, specifier: m[2], symbols: [] });
  }
  for (const h of hits) {
    out.addDep(
      h.at,
      h.specifier,
      h.symbols,
      !h.specifier.startsWith("."),
      h.reExported,
      h.bindings
    );
  }
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

const RUST_ATTRS = String.raw`(?:#!?\[[^\]]{0,500}\]\s*)*`;
const RUST_VIS = String.raw`(?:(pub(?:\s*\([^)]{0,100}\))?)\s+)?`;
const RE_RS_FN = new RegExp(
  `${RUST_ATTRS}${RUST_VIS}(?:default\\s+)?(?:const\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:extern\\s+)?fn\\s+([A-Za-z_]\\w*)`,
  "y"
);
const RE_RS_TYPE_ITEM = new RegExp(
  `${RUST_ATTRS}${RUST_VIS}(struct|enum|union|trait|type|mod)\\s+([A-Za-z_]\\w*)`,
  "y"
);
const RE_RS_CONST = new RegExp(
  `${RUST_ATTRS}${RUST_VIS}(const|static)\\s+(?:mut\\s+)?([A-Za-z_]\\w*)(?=\\s*:)`,
  "y"
);
const RE_RS_MACRO = new RegExp(`${RUST_ATTRS}macro_rules!\\s*([A-Za-z_]\\w*)`, "y");
const RE_RS_IMPL = new RegExp(`${RUST_ATTRS}(?:unsafe\\s+)?impl\\b`, "y");

/** Exported only for an unrestricted `pub`; `pub(crate)`, `pub(super)`, `pub(in …)` are crate-internal. */
function rustExported(vis: string | undefined): boolean {
  return !!vis && vis.replace(/\s+/g, "") === "pub";
}

function rustTypeBase(typeText: string): string {
  let t = typeText.trim();
  // Strip generic arguments (balanced) and reference/pointer prefixes.
  let depth = 0;
  let stripped = "";
  for (const ch of t) {
    if (ch === "<") depth++;
    else if (ch === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0) stripped += ch;
  }
  t = stripped
    .replace(/^[&*\s]+/, "")
    .replace(/^(?:mut|const|dyn)\s+/, "")
    .trim();
  const seg = t.split("::").pop() ?? t;
  const m = /[A-Za-z_]\w*/.exec(seg);
  return m ? m[0] : "";
}

/**
 * The path segments of a type or trait as written (`a::b::Foo<T>` gives `a`, `b`, `Foo`),
 * without generics and reference prefixes. Empty when the text is not a plain path
 * (tuples, slices, fn pointers), so such a type is never matched to a declaration.
 */
function rustPathSegments(typeText: string): string[] {
  let depth = 0;
  let stripped = "";
  for (const ch of typeText) {
    if (ch === "<") depth++;
    else if (ch === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0) stripped += ch;
  }
  const t = stripped
    .replace(/^[&*\s]+/, "")
    .replace(/^'[A-Za-z_]\w*\s+/, "")
    .replace(/^(?:mut|const|dyn)\s+/, "")
    .trim();
  const m = /^(?:::)?\s*[A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*\s*$/.exec(t);
  return m
    ? t
        .replace(/^::/, "")
        .split(/\s*::\s*/)
        .map((s) => s.trim())
    : [];
}

function extractRust(content: string, relPath: string): Extraction {
  const src = new Source(dropLongLines(content), lexRust);
  const out = new Collector(src, relPath);
  const code = src.code;

  // Attributes (`#[derive(Debug)]`) belong to the item that follows: `p` is
  // where the attributes start (so the item's range includes them) and `q`
  // where the item itself starts. The item is matched once, at `p`; the
  // statement start that the newline after the attributes creates is skipped.
  let suppressUntil = 0;
  // Methods of `impl Trait for Type`: visibility comes from the trait and the type,
  // not from a `pub` on the method (which Rust forbids there). Settled after the scan.
  const traitImplMethods: Array<{
    sym: IndexedSymbol;
    typePath: string[];
    traitPath: string[];
    atTop: boolean;
  }> = [];
  // Top-level `mod foo;` declarations (the module lives in another file).
  const fileMods = new Set<string>();
  scanBlocks(code, (p, scope) => {
    if (p < suppressUntil) return undefined;
    const c = code[p];
    if (!/[A-Za-z#]/.test(c)) return undefined;
    const attrLen =
      c === "#"
        ? (/^(?:#!?\[[^\]]*\]\s*)*/.exec(code.slice(p, p + 600)) as RegExpExecArray)[0].length
        : 0;
    const q = p + attrLen;
    if (attrLen > 0) suppressUntil = q + 1;
    const container = scope.kind === "class" || scope.kind === "namespace" ? scope.name : undefined;

    let m = sticky(RE_RS_FN, code, q);
    if (m) {
      const name = m[2];
      const nameAt = q + m[0].length - name.length;
      const open = findRustParamsOpen(code, q + m[0].length);
      let sigEnd = q + m[0].length;
      let end: number | undefined;
      if (open >= 0) {
        const header = findRustFnBody(src, open);
        if (header.body >= 0) {
          sigEnd = header.body;
          const close = src.matchClose(header.body);
          end = close < 0 ? undefined : close;
        } else if (header.semi >= 0) {
          sigEnd = header.semi;
          end = header.semi;
        }
      }
      const before = out.symbols.length;
      out.addSymbol({
        name,
        kind: "function",
        at: p,
        nameAt,
        end,
        signature: src.signature(q, sigEnd),
        exported: rustExported(m[1]) || (scope.isTrait === true && scope.exported === true),
        container,
      });
      if (scope.traitImpl && out.symbols.length > before) {
        traitImplMethods.push({
          sym: out.symbols[out.symbols.length - 1],
          typePath: scope.typePath ?? [],
          traitPath: scope.traitPath ?? [],
          atTop: scope.implAtTop === true,
        });
      }
      return undefined;
    }

    m = sticky(RE_RS_TYPE_ITEM, code, q);
    if (m) {
      const kw = m[2];
      const name = m[3];
      const nameAt = q + m[0].length - name.length;
      const exported = rustExported(m[1]);
      const kind: SymbolKind =
        kw === "trait" ? "interface" : kw === "type" ? "type" : kw === "mod" ? "module" : "class";
      const body = kw === "type" ? -1 : findBodyBrace(code, q + m[0].length);
      const semi = code.indexOf(";", q + m[0].length);
      let end: number | undefined;
      if (body >= 0 && (semi < 0 || body < semi || kw === "trait")) {
        const close = src.matchClose(body);
        end = close < 0 ? undefined : close;
      } else if (semi >= 0) {
        end = semi;
      }
      out.addSymbol({
        name,
        kind,
        at: p,
        nameAt,
        end,
        signature: src.signature(
          q,
          Math.min(body >= 0 ? body : semi >= 0 ? semi : nameAt + name.length, p + 160)
        ),
        exported,
        container,
      });
      // `mod foo;` (a declaration, not an inline `mod foo { }`) links this file to the
      // file holding the module. Only at the top of a file: inside an inline module
      // the file lives one directory deeper, which the resolver would have to guess.
      // With a plain `#[path = "x.rs"]` the declaration is linked as `path:x.rs`
      // (relative to this file's directory); any other `path =` form (`cfg_attr`,
      // a raw string) is left unlinked rather than guessed.
      if (kw === "mod" && body < 0 && semi >= 0 && scope.kind === "top") {
        fileMods.add(name);
        if (!/\bpath\s*=/.test(code.slice(p, q))) {
          out.addDep(p, `self::${name}`, [], false);
        } else {
          const pathValue = /#\[\s*path\s*=\s*"([^"\\\r\n]{1,512})"\s*\]/.exec(
            src.text.slice(p, q)
          )?.[1];
          if (pathValue) out.addDep(p, `path:${pathValue}`, [], false);
        }
      }
      if (kw === "trait" || kw === "mod") {
        return {
          scope: {
            kind: kw === "trait" ? "class" : "namespace",
            name,
            exported,
            isTrait: kw === "trait",
          },
        };
      }
      return undefined;
    }

    m = sticky(RE_RS_CONST, code, q);
    if (m) {
      const name = m[3];
      const nameAt = q + m[0].length - name.length;
      const isMut = /\bmut\b/.test(m[0]);
      out.addSymbol({
        name,
        kind: m[2] === "static" && isMut ? "variable" : "constant",
        at: p,
        nameAt,
        end: findRustItemEnd(code, q + m[0].length),
        signature: src.signature(
          q,
          Math.min(code.indexOf("=", q) > 0 ? code.indexOf("=", q) : p + 120, p + 160)
        ),
        exported: rustExported(m[1]),
        container,
      });
      return undefined;
    }

    m = sticky(RE_RS_MACRO, code, q);
    if (m) {
      const name = m[1];
      const body = findBodyBrace(code, q + m[0].length);
      const close = body >= 0 ? src.matchClose(body) : -1;
      out.addSymbol({
        name,
        kind: "function",
        at: p,
        nameAt: q + m[0].length - name.length,
        end: close >= 0 ? close : undefined,
        signature: `macro_rules! ${name}`,
        exported: false,
        container,
      });
      return undefined;
    }

    m = sticky(RE_RS_IMPL, code, q);
    if (m) {
      const afterImpl = q + m[0].length;
      const body = findBodyBrace(code, afterImpl);
      if (body < 0) return undefined;
      let header = code.slice(afterImpl, body);
      const generics = skipAngles(header, 0);
      header = header.slice(generics).replace(/\bwhere\b[\s\S]*$/, "");
      const forM = /\bfor\b/.exec(header);
      const typeText = forM ? header.slice(forM.index + forM[0].length) : header;
      const name = rustTypeBase(typeText);
      return {
        scope: {
          kind: "class",
          name: name || undefined,
          exported: false,
          traitImpl: !!forM,
          ...(forM
            ? {
                traitName: rustTypeBase(header.slice(0, forM.index)) || undefined,
                typePath: rustPathSegments(typeText),
                traitPath: rustPathSegments(header.slice(0, forM.index)),
                implAtTop: scope.kind === "top",
              }
            : {}),
        },
      };
    }
    return undefined;
  });

  const useBindings = new Map<string, string | null>();
  collectRustUses(src, out, useBindings);
  settleRustTraitImplMethods(out.symbols, traitImplMethods, useBindings, fileMods);
  return out.result();
}

/**
 * A trait-impl method is callable from outside the crate when the type is unrestricted
 * `pub` and the trait is not a private trait. What this file declares decides here; a type
 * or trait declared elsewhere is recorded as `implOf` (its path with this file's `use`
 * bindings expanded) for the cross-file pass (`settleRustImplExports`) to decide on every
 * build. Anything that cannot be tied to one declaration stays unexported, never guessed.
 */
function settleRustTraitImplMethods(
  symbols: IndexedSymbol[],
  methods: ReadonlyArray<{
    sym: IndexedSymbol;
    typePath: string[];
    traitPath: string[];
    atTop: boolean;
  }>,
  uses: ReadonlyMap<string, string | null>,
  fileMods: ReadonlySet<string>
): void {
  const topLevel = (name: string, kind: SymbolKind): IndexedSymbol | undefined =>
    symbols.find((s) => s.name === name && !s.container && s.kind === kind);
  // The declaration a path names in this file: `Foo` or `self::Foo`. A longer path
  // (`other::Foo`) names something else even when this file also declares a `Foo`.
  const declared = (segs: string[], kind: SymbolKind): IndexedSymbol | undefined => {
    if (segs.length === 1) return topLevel(segs[0], kind);
    if (segs.length === 2 && segs[0] === "self") return topLevel(segs[1], kind);
    return undefined;
  };
  type Ref = { path: string } | { exported: boolean } | null; // null: cannot be pinned down
  const refOf = (segs: string[], kind: SymbolKind): Ref => {
    const first = segs[0];
    if (!first) return null;
    if (first === "crate" || first === "self" || first === "super") {
      return { path: segs.join("::") };
    }
    if (uses.has(first)) {
      const bound = uses.get(first);
      return bound ? { path: [bound, ...segs.slice(1)].join("::") } : null;
    }
    // `mod net;` then `net::Client`: a child module of this file, written without `self::`.
    if (segs.length > 1 && fileMods.has(first)) return { path: `self::${segs.join("::")}` };
    // `mod inner { ... }` of this file: its members are visible to this file's symbols.
    const inline = symbols.find((s) => s.name === first && !s.container && s.kind === "module");
    if (inline) {
      if (segs.length !== 2) return null;
      const member = symbols.find(
        (s) => s.name === segs[1] && s.container === first && s.kind === kind
      );
      return member ? { exported: member.isExported } : null;
    }
    return { path: segs.join("::") };
  };

  for (const { sym, typePath, traitPath, atTop } of methods) {
    sym.isExported = false;
    if (typePath.length === 0 || traitPath.length === 0) continue;

    let typeNeed: string | undefined;
    const typeSym = declared(typePath, "class");
    if (typeSym) {
      if (!typeSym.isExported) continue;
    } else {
      if (!atTop) continue;
      const ref = refOf(typePath, "class");
      if (!ref) continue;
      if ("exported" in ref) {
        if (!ref.exported) continue;
      } else typeNeed = ref.path;
    }

    let traitNeed: string | undefined;
    const traitSym = declared(traitPath, "interface");
    if (traitSym) {
      if (!traitSym.isExported) continue;
    } else if (atTop) {
      const ref = refOf(traitPath, "interface");
      if (!ref) continue;
      if ("exported" in ref) {
        if (!ref.exported) continue;
      } else traitNeed = ref.path;
    }

    if (typeNeed === undefined && traitNeed === undefined) {
      sym.isExported = true;
      continue;
    }
    // Same-file guess until the cross-file pass runs: a local public type with a trait
    // from elsewhere counts as exported (as before); a type from elsewhere does not.
    sym.isExported = typeNeed === undefined;
    sym.implOf = {
      ...(typeNeed !== undefined ? { type: typeNeed } : {}),
      ...(traitNeed !== undefined ? { trait: traitNeed } : {}),
    };
  }
}

function findRustParamsOpen(code: string, from: number): number {
  const i = skipAngles(code, from);
  const open = skipWs(code, i);
  return code[open] === "(" ? open : -1;
}

/** After a Rust fn's params, find the body `{` or the terminating `;`. */
function findRustFnBody(src: Source, paramsOpen: number): { body: number; semi: number } {
  const code = src.code;
  const afterParams = skipBalanced(code, paramsOpen, "(", ")");
  if (afterParams < 0) return { body: -1, semi: -1 };
  let paren = 0;
  const limit = Math.min(code.length, afterParams + MAX_HEADER_SCAN);
  for (let i = afterParams; i < limit; i++) {
    const c = code[i];
    if (c === "(" || c === "[") paren++;
    else if (c === ")" || c === "]") paren = Math.max(0, paren - 1);
    else if (paren === 0) {
      if (c === "{") return { body: i, semi: -1 };
      if (c === ";") return { body: -1, semi: i };
    }
  }
  return { body: -1, semi: -1 };
}

function findRustItemEnd(code: string, from: number): number | undefined {
  const semi = code.indexOf(";", from);
  return semi < 0 ? undefined : semi;
}

/** One imported item of a `use` tree: `parent::name`, visible to importers as `exported`. */
interface UseLeaf {
  parent: string;
  name: string;
  exported: string;
}

const MAX_USE_TREE_DEPTH = 8;
const MAX_USE_LEAVES = 200;

/** Split `a, b::{c, d}, e` at the commas that are not inside braces. */
function splitUseList(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((x) => x.trim()).filter(Boolean);
}

/**
 * Leaves of a braced `use` tree, with nested groups flattened:
 * `crate::a::{b::{c, d}, e as f, self}` gives `crate::a::b` -> c, d; `crate::a` -> e (as f)
 * and `crate` -> a. A `self` leaf is the module named by its prefix.
 */
function expandUseTree(prefix: string, tree: string, leaves: UseLeaf[], depth: number): void {
  if (depth > MAX_USE_TREE_DEPTH || leaves.length >= MAX_USE_LEAVES) return;
  const text = tree.trim();
  if (!text) return;
  const open = text.indexOf("{");
  if (open < 0) {
    const [path, alias] = text.split(/\s+as\s+/).map((x) => x.trim());
    const segs = (path === "self" ? prefix : `${prefix}${path}`).split("::").filter(Boolean);
    if (segs.length === 0) return;
    const name = segs[segs.length - 1];
    leaves.push({ parent: segs.slice(0, -1).join("::"), name, exported: alias || name });
    return;
  }
  const head = text.slice(0, open);
  const close = skipBalanced(text, open, "{", "}");
  if (close < 0) return;
  for (const part of splitUseList(text.slice(open + 1, close - 1))) {
    expandUseTree(`${prefix}${head}`, part, leaves, depth + 1);
  }
}

function collectRustUses(src: Source, out: Collector, bindings?: Map<string, string | null>): void {
  // Local name -> full path of what it imports; null when the same name is bound to two
  // different paths in this file (an inline module or a function body can do that).
  const bind = (local: string, full: string): void => {
    if (!bindings || !local || local === "_" || local === "*" || local === "self") return;
    bindings.set(local, bindings.has(local) && bindings.get(local) !== full ? null : full);
  };
  const text = src.noComments;
  const code = src.code;
  const useRe =
    /(?:^|[\s;{}])(pub(?:\s*\([^)]{0,100}\))?\s+)?use\s+((?:(?!\buse\b)[^;]){1,3000});/g;
  for (let m = useRe.exec(text); m; m = useRe.exec(text)) {
    const at = m.index + m[0].indexOf("use");
    if (!code.startsWith("use", at)) continue;
    const isPub = !!m[1];
    const raw = m[2].replace(/\s+/g, " ").trim();
    const addUse = (specifier: string, symbols: string[], exported: string[]): void => {
      const internal = /^(?:crate|self|super)(?:::|$)/.test(specifier);
      out.addDep(at, specifier, symbols, !internal, isPub ? exported : undefined);
    };
    if (!raw.includes("{")) {
      // `use a::b::C [as D];`: one import; the specifier is the whole path.
      const [path, alias] = raw.split(/\s+as\s+/).map((x) => x.trim());
      const last = path.split("::").pop() || "";
      if (path && last) {
        addUse(path, [last], [last === "*" ? "*" : alias || last]);
        bind(alias || last, path);
      }
      continue;
    }
    const leaves: UseLeaf[] = [];
    expandUseTree("", raw, leaves, 0);
    // One dependency per parent module, in order of first appearance.
    const byParent = new Map<string, UseLeaf[]>();
    for (const leaf of leaves) {
      const list = byParent.get(leaf.parent);
      if (list) list.push(leaf);
      else byParent.set(leaf.parent, [leaf]);
    }
    for (const leaf of leaves) {
      bind(leaf.exported, leaf.parent ? `${leaf.parent}::${leaf.name}` : leaf.name);
    }
    for (const [parent, group] of byParent) {
      if (!parent) continue;
      addUse(
        parent,
        group.map((l) => l.name),
        group.map((l) => (l.name === "*" ? "*" : l.exported))
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

const RE_GO_FUNC = /func\b\s*(?:\(([^)]*)\)\s*)?([A-Za-z_]\w*)/y;
const RE_GO_TYPE = /type\s+([A-Za-z_]\w*)/y;
const RE_GO_VALUE = /(const|var)\s+([A-Za-z_]\w*)/y;
const RE_GO_GROUP = /(const|var|type|import)\s*\(/y;
const RE_GO_SPEC_NAMES = /([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)/y;

function goReceiverType(receiver: string): string {
  const m = /([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*$/.exec(receiver.replace(/\*/g, " ").trim());
  return m ? m[1] : "";
}

type GoGroup = "const" | "var" | "type" | "import" | null;

const isGoExported = (name: string): boolean => /^[A-Z]/.test(name);

/** Find a Go func's body `{` (skipping `interface{}` / `struct{}` types) or its end. */
function findGoFuncEnd(src: Source, from: number): { sigEnd: number; end: number | undefined } {
  const code = src.code;
  let paren = 0;
  const limit = Math.min(code.length, from + MAX_HEADER_SCAN);
  for (let i = from; i < limit; i++) {
    const c = code[i];
    if (c === "(" || c === "[") paren++;
    else if (c === ")" || c === "]") paren = Math.max(0, paren - 1);
    else if (c === "{") {
      if (paren > 0) {
        const close = src.matchClose(i);
        if (close < 0) break;
        i = close;
        continue;
      }
      const before = code.slice(Math.max(0, i - 12), i).trimEnd();
      if (/\b(?:interface|struct)$/.test(before)) {
        const close = src.matchClose(i);
        if (close < 0) break;
        i = close;
        continue;
      }
      const close = src.matchClose(i);
      return { sigEnd: i, end: close < 0 ? undefined : close };
    } else if (c === "\n" && paren === 0) {
      const last = lastNonSpace(code, from, i);
      if (last >= from && code[last] !== "," && code[last] !== "(" && code[last] !== "[") {
        return { sigEnd: last + 1, end: last };
      }
    }
  }
  return { sigEnd: Math.min(code.length, from), end: undefined };
}

function extractGo(content: string, relPath: string): Extraction {
  const src = new Source(dropLongLines(content), lexGo);
  const out = new Collector(src, relPath);
  const code = src.code;

  let brace = 0;
  let paren = 0;
  let group: GoGroup = null;
  let atStart = true;

  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "\n") {
      atStart = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") continue;
    const wasStart = atStart;
    atStart = false;

    if (wasStart && brace === 0) {
      if (paren === 0) {
        let m = sticky(RE_GO_GROUP, code, i);
        if (m) {
          group = m[1] as GoGroup;
        } else if ((m = sticky(RE_GO_FUNC, code, i)) && code.startsWith("func", i)) {
          const name = m[2];
          const nameAt = i + m[0].length - name.length;
          const receiverType = m[1] !== undefined ? goReceiverType(m[1]) : "";
          const { sigEnd, end } = findGoFuncEnd(src, i + m[0].length);
          out.addSymbol({
            name,
            kind: "function",
            at: i,
            nameAt,
            end,
            signature: src.signature(i, sigEnd),
            exported: isGoExported(name),
            container: receiverType || undefined,
          });
        } else if ((m = sticky(RE_GO_TYPE, code, i)) && /^type\s/.test(code.slice(i, i + 5))) {
          goTypeDecl(src, out, i, i + m[0].length - m[1].length, m[1], i + m[0].length);
        } else if (
          (m = sticky(RE_GO_VALUE, code, i)) &&
          /^(?:const|var)\s/.test(code.slice(i, i + 6))
        ) {
          const name = m[2];
          const nameAt = i + m[0].length - name.length;
          out.addSymbol({
            name,
            kind: m[1] === "const" ? "constant" : "variable",
            at: i,
            nameAt,
            end: findStatementEnd(code, i + m[0].length),
            signature: src.signature(i, Math.min(findStatementEnd(code, i) + 1, i + 120)),
            exported: isGoExported(name),
          });
        }
      } else if (paren === 1 && group && group !== "import") {
        // A spec line inside `const (...)`, `var (...)` or `type (...)`.
        if (group === "type") {
          const hit = sticky(/([A-Za-z_]\w*)/y, code, i);
          if (hit) goTypeDecl(src, out, i, i, hit[1], i + hit[0].length);
        } else {
          const names = sticky(RE_GO_SPEC_NAMES, code, i);
          if (names) {
            const end = findStatementEnd(code, i + names[0].length);
            for (const raw of names[1].split(",")) {
              const name = raw.trim();
              if (!name || name === "_") continue;
              const nameAt = code.indexOf(name, i);
              out.addSymbol({
                name,
                kind: group === "const" ? "constant" : "variable",
                at: i,
                nameAt,
                end,
                signature: src.signature(i, Math.min(end + 1, i + 120)),
                exported: isGoExported(name),
              });
            }
          }
        }
      }
    }

    switch (c) {
      case "{":
        brace++;
        break;
      case "}":
        brace = Math.max(0, brace - 1);
        break;
      case "(":
        paren++;
        break;
      case ")":
        paren = Math.max(0, paren - 1);
        if (paren === 0) group = null;
        break;
      default:
        break;
    }
  }

  collectGoImports(src, out);
  return out.result();
}

function goTypeDecl(
  src: Source,
  out: Collector,
  at: number,
  nameAt: number,
  name: string,
  afterName: number
): void {
  const code = src.code;
  const rest = code.slice(afterName, afterName + 60);
  const structM = /^(?:\s*\[[^\]]*\])?\s*(struct|interface)\b/.exec(rest);
  let kind: SymbolKind = "type";
  let end: number | undefined;
  if (structM) {
    kind = structM[1] === "struct" ? "class" : "interface";
    const body = code.indexOf("{", afterName);
    const close = body >= 0 ? src.matchClose(body) : -1;
    end = close >= 0 ? close : undefined;
  } else {
    end = findStatementEnd(code, afterName);
  }
  out.addSymbol({
    name,
    kind,
    at,
    nameAt,
    end,
    signature: src.signature(
      at,
      Math.min(afterName + (structM ? structM[0].length : 40), at + 160)
    ),
    exported: isGoExported(name),
  });
}

function collectGoImports(src: Source, out: Collector): void {
  const text = src.noComments;
  const code = src.code;
  const single = /(?:^|\n)[ \t]*import\s+(?:([A-Za-z_.]\w*)\s+)?"([^"\n]+)"/g;
  for (let m = single.exec(text); m; m = single.exec(text)) {
    const at = m.index + m[0].indexOf("import");
    if (!code.startsWith("import", at)) continue;
    out.addDep(at, m[2], m[1] ? [m[1]] : [], !m[2].startsWith("."));
  }
  const block = /(?:^|\n)[ \t]*import\s*\(((?:(?!\bimport\b)[^)]){0,6000})\)/g;
  for (let m = block.exec(text); m; m = block.exec(text)) {
    const at = m.index + m[0].indexOf("import");
    if (!code.startsWith("import", at)) continue;
    const bodyStart = m.index + m[0].indexOf("(") + 1;
    const specRe = /(?:^|\n)[ \t]*(?:([A-Za-z_.]\w*)\s+)?"([^"\n]+)"/g;
    for (let s = specRe.exec(m[1]); s; s = specRe.exec(m[1])) {
      out.addDep(bodyStart + s.index, s[2], s[1] ? [s[1]] : [], !s[2].startsWith("."));
    }
  }
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

interface LogicalLine {
  startLine: number;
  endLine: number;
  indent: number;
  start: number; // offset of first non-space char
  text: string;
}

function indentWidth(line: string): number {
  let w = 0;
  for (const ch of line) {
    if (ch === " ") w++;
    else if (ch === "\t") w += 8 - (w % 8);
    else break;
  }
  return w;
}

function pythonLogicalLines(src: Source): LogicalLine[] {
  const lines = src.code.split("\n");
  const result: LogicalLine[] = [];
  let depth = 0;
  let cur: LogicalLine | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, "");
    const stripped = raw.trim();
    if (cur === null) {
      if (stripped === "") continue;
      cur = {
        startLine: i + 1,
        endLine: i + 1,
        indent: indentWidth(raw),
        start: src.lineStarts[i] + (raw.length - raw.trimStart().length),
        text: stripped,
      };
    } else {
      cur.text += " " + stripped;
      cur.endLine = i + 1;
    }
    for (const ch of raw) {
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    }
    const continued = depth > 0 || raw.trimEnd().endsWith("\\");
    if (!continued) {
      result.push(cur);
      cur = null;
      depth = 0;
    }
  }
  if (cur) result.push(cur);
  return result;
}

interface PyScope {
  indent: number;
  kind: "class" | "def" | "block";
  name?: string;
  exported?: boolean;
  symbolIndex?: number;
}

const PY_BLOCK_KEYWORDS = /^(?:if|elif|else|try|except|finally|with|for|while|match|case)\b/;

function extractPython(content: string, relPath: string): Extraction {
  const src = new Source(dropLongLines(content), lexPython);
  const out = new Collector(src, relPath);
  const logical = pythonLogicalLines(src);
  const stack: PyScope[] = [];

  const closeScopes = (downTo: number, lastEnd: number): void => {
    while (stack.length > 0 && downTo <= stack[stack.length - 1].indent) {
      const popped = stack.pop() as PyScope;
      if (popped.symbolIndex !== undefined) {
        const sym = out.symbols[popped.symbolIndex];
        if (sym && lastEnd >= sym.location.line) sym.location.endLine = lastEnd;
      }
    }
  };

  let prevEnd = 0;
  for (const ll of logical) {
    closeScopes(ll.indent, prevEnd);
    prevEnd = ll.endLine;
    const text = ll.text;

    // Imports are recorded at any indentation (conditional / local imports included).
    const imp = /^import\s+(.+)$/.exec(text);
    const from = /^from\s+(\.*[\w.]*)\s+import\s+(.+)$/.exec(text);
    if (from) {
      const names = from[2]
        .replace(/[()]/g, " ")
        .split(",")
        .map((s) =>
          s
            .trim()
            .split(/\s+as\s+/)[0]
            .trim()
        )
        .filter(Boolean);
      // Inside a package's `__init__.py`, a relative `from .mod import x` is how a
      // package re-exports `x`: importers of the package reach `mod` through it.
      let reExported: string[] | undefined;
      if (from[1].startsWith(".") && /(?:^|\/)__init__\.py$/.test(relPath)) {
        // The name importers use is the alias when there is one (`from .m import x as y`).
        reExported = from[2]
          .replace(/[()]/g, " ")
          .split(",")
          .map((part) => {
            const bits = part.trim().split(/\s+as\s+/);
            return (bits[1] ?? bits[0]).trim();
          })
          .filter(Boolean);
      }
      out.addDep(ll.start, from[1], names, !from[1].startsWith("."), reExported);
    } else if (imp) {
      for (const part of imp[1].split(",")) {
        const mod = part
          .trim()
          .split(/\s+as\s+/)[0]
          .trim();
        if (/^[\w.]+$/.test(mod)) out.addDep(ll.start, mod, [], true);
      }
    }

    // The nearest class/def decides where this line lives; `if/try/with` blocks are transparent.
    let owner: PyScope | undefined;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].kind !== "block") {
        owner = stack[i];
        break;
      }
    }

    const def = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(text);
    const cls = /^class\s+([A-Za-z_]\w*)/.exec(text);
    const isBlockHeader = PY_BLOCK_KEYWORDS.test(text) && text.trimEnd().endsWith(":");

    if (def || cls) {
      const name = (def ?? cls)![1];
      const kind: "function" | "class" = def ? "function" : "class";
      const local = owner?.kind === "def";
      const container = owner?.kind === "class" ? owner.name : undefined;
      const ownerExported = owner?.kind === "class" ? owner.exported !== false : true;
      const exported = !name.startsWith("_") && ownerExported;
      let symbolIndex: number | undefined;
      if (!local) {
        out.addSymbol({
          name,
          kind,
          at: ll.start,
          nameAt: src.code.indexOf(name, ll.start),
          end: undefined,
          signature: text.slice(0, MAX_SIGNATURE_CHARS),
          exported,
          container,
        });
        symbolIndex = out.symbols.length - 1;
        const sym = out.symbols[symbolIndex];
        // One-line definitions end on their own line until a deeper block extends them.
        if (sym) sym.location.endLine = ll.endLine;
      }
      stack.push({
        indent: ll.indent,
        kind: def ? "def" : "class",
        name,
        exported,
        symbolIndex,
      });
      continue;
    }

    if (isBlockHeader) {
      stack.push({ indent: ll.indent, kind: "block" });
      continue;
    }

    // Module-level assignment: `NAME = ...` or `NAME: T = ...` (simple names only).
    if (!owner) {
      const asg = /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/.exec(text);
      if (
        asg &&
        !/^(?:return|yield|del|assert|raise|pass|break|continue|print|global|nonlocal)$/.test(
          asg[1]
        )
      ) {
        const name = asg[1];
        out.addSymbol({
          name,
          kind: /^[A-Z][A-Z0-9_]*$/.test(name) ? "constant" : "variable",
          at: ll.start,
          nameAt: ll.start,
          end: undefined,
          signature: text.slice(0, 120),
          exported: !name.startsWith("_"),
        });
        const sym = out.symbols[out.symbols.length - 1];
        if (sym) sym.location.endLine = ll.endLine;
      }
    }
  }
  closeScopes(-1, prevEnd);
  return out.result();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Extract top-level symbols, class/impl members and import dependencies.
 * `language` is the indexer's language id; `relativePath` is only used for
 * provenance fields. Never throws.
 */
export function extractSymbolsAndDeps(
  content: string,
  relativePath: string,
  language: string
): Extraction {
  try {
    switch (language) {
      case "typescript":
      case "javascript":
        return extractTs(content, relativePath);
      case "rust":
        return extractRust(content, relativePath);
      case "python":
        return extractPython(content, relativePath);
      case "go":
        return extractGo(content, relativePath);
      default:
        return { symbols: [], dependencies: [] };
    }
  } catch {
    // A scanner bug on odd input must never fail indexing; the file is simply
    // indexed without symbols.
    return { symbols: [], dependencies: [] };
  }
}
