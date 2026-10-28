import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Directories (root-relative, posix; `""` is the project root) that hold top-level
 * Python packages, for resolving absolute imports of project modules.
 *
 * Always searched: the project root and `src/`. On top of that, for every
 * `pyproject.toml` / `setup.cfg` among the indexed files: its own directory and
 * `src/` below it (a monorepo package), and the source directories it declares:
 *  - `[tool.setuptools] package-dir` (`"" = "src"`, or `pkg = "lib/pkg"` when the
 *    directory is named after the package) and `packages.find.where`,
 *  - `[tool.poetry] packages = [{ include, from }]`,
 *  - `[tool.hatch.build.targets.wheel] packages = ["src/pkg"]`,
 *  - `[tool.pdm.build] package-dir`, `[tool.maturin] python-source`,
 *  - `[tool.pytest.ini_options] pythonpath`,
 *  - `setup.cfg` `[options] package_dir` and `[options.packages.find] where`.
 *
 * Only the keys above are read, with a small tolerant TOML/INI reader (not a full
 * parser; a construct it does not understand is skipped, never an error). Reads are
 * bounded (`MAX_CONFIG_BYTES`, regular files only, no symlinks, confined to the
 * project root) and at most `MAX_PYTHON_CONFIGS` configs and `MAX_PYTHON_ROOTS`
 * roots are used. Nothing is executed: `setup.py` is never read.
 */

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_PYTHON_CONFIGS = 32;
const MAX_PYTHON_ROOTS = 64;
const MAX_TOML_DEPTH = 16;

/** Roots searched whatever the configuration says. */
export const DEFAULT_PYTHON_ROOTS: readonly string[] = ["", "src"];

type TomlValue = string | TomlValue[] | TomlTable;
interface TomlTable {
  [key: string]: TomlValue;
}

function newTable(): TomlTable {
  return Object.create(null) as TomlTable;
}

function isTable(v: unknown): v is TomlTable {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// TOML subset
// ---------------------------------------------------------------------------

class TomlReader {
  private i = 0;
  constructor(private readonly s: string) {}

  private skipSpace(newlines: boolean): void {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === " " || c === "\t" || c === "\r") this.i++;
      else if (c === "\n" && newlines) this.i++;
      else if (c === "#") {
        while (this.i < s.length && s[this.i] !== "\n") this.i++;
      } else break;
    }
  }

  private skipLine(): void {
    while (this.i < this.s.length && this.s[this.i] !== "\n") this.i++;
  }

  private parseString(): string {
    const s = this.s;
    const q = s[this.i];
    const triple = s.startsWith(q.repeat(3), this.i);
    if (triple) {
      const end = s.indexOf(q.repeat(3), this.i + 3);
      if (end < 0) throw new Error("unterminated string");
      const text = s.slice(this.i + 3, end);
      this.i = end + 3;
      return text;
    }
    this.i++;
    let out = "";
    while (this.i < s.length && s[this.i] !== "\n") {
      const c = s[this.i];
      if (c === q) {
        this.i++;
        return out;
      }
      if (q === '"' && c === "\\" && this.i + 1 < s.length) {
        const n = s[this.i + 1];
        out += n === "n" ? "\n" : n === "t" ? "\t" : n;
        this.i += 2;
        continue;
      }
      out += c;
      this.i++;
    }
    throw new Error("unterminated string");
  }

  private parseKeyPath(): string[] {
    const keys: string[] = [];
    for (;;) {
      this.skipSpace(false);
      const c = this.s[this.i];
      if (c === '"' || c === "'") keys.push(this.parseString());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(this.s.slice(this.i, this.i + 200));
        if (!m) throw new Error("bad key");
        keys.push(m[0]);
        this.i += m[0].length;
      }
      this.skipSpace(false);
      if (this.s[this.i] === ".") this.i++;
      else return keys;
    }
  }

  private parseValue(depth: number): TomlValue {
    if (depth > MAX_TOML_DEPTH) throw new Error("too deep");
    this.skipSpace(false);
    const c = this.s[this.i];
    if (c === '"' || c === "'") return this.parseString();
    if (c === "[") {
      this.i++;
      const items: TomlValue[] = [];
      for (;;) {
        this.skipSpace(true);
        if (this.s[this.i] === "]") {
          this.i++;
          return items;
        }
        if (this.i >= this.s.length) throw new Error("unterminated array");
        items.push(this.parseValue(depth + 1));
        this.skipSpace(true);
        if (this.s[this.i] === ",") this.i++;
      }
    }
    if (c === "{") {
      this.i++;
      const table = newTable();
      for (;;) {
        this.skipSpace(true);
        if (this.s[this.i] === "}") {
          this.i++;
          return table;
        }
        if (this.i >= this.s.length) throw new Error("unterminated table");
        const keys = this.parseKeyPath();
        this.skipSpace(false);
        if (this.s[this.i] !== "=") throw new Error("expected =");
        this.i++;
        setPath(table, keys, this.parseValue(depth + 1));
        this.skipSpace(true);
        if (this.s[this.i] === ",") this.i++;
      }
    }
    // Number, boolean, date: kept as raw text.
    const m = /^[^,\]}\n#]*/.exec(this.s.slice(this.i, this.i + 200));
    const raw = (m ? m[0] : "").trim();
    this.i += m ? m[0].length : 0;
    return raw;
  }

  read(): TomlTable {
    const root = newTable();
    let current = root;
    while (this.i < this.s.length) {
      this.skipSpace(true);
      if (this.i >= this.s.length) break;
      try {
        if (this.s[this.i] === "[") {
          const isArray = this.s[this.i + 1] === "[";
          this.i += isArray ? 2 : 1;
          const keys = this.parseKeyPath();
          this.skipSpace(false);
          this.i += isArray ? 2 : 1; // closing bracket(s)
          current = isArray ? appendTable(root, keys) : ensureTable(root, keys);
        } else {
          const keys = this.parseKeyPath();
          this.skipSpace(false);
          if (this.s[this.i] !== "=") throw new Error("expected =");
          this.i++;
          setPath(current, keys, this.parseValue(0));
        }
        this.skipSpace(false);
        this.skipLine();
      } catch {
        this.skipLine();
      }
    }
    return root;
  }
}

function safeKey(k: string): boolean {
  return k !== "__proto__" && k !== "constructor" && k !== "prototype";
}

function ensureTable(from: TomlTable, keys: string[]): TomlTable {
  let t = from;
  for (const k of keys) {
    if (!safeKey(k)) throw new Error("unsafe key");
    let next = t[k];
    if (Array.isArray(next)) next = next[next.length - 1];
    if (!isTable(next)) {
      next = newTable();
      t[k] = next;
    }
    t = next;
  }
  return t;
}

function appendTable(from: TomlTable, keys: string[]): TomlTable {
  const parent = ensureTable(from, keys.slice(0, -1));
  const last = keys[keys.length - 1];
  if (!safeKey(last)) throw new Error("unsafe key");
  let list = parent[last];
  if (!Array.isArray(list)) {
    list = [];
    parent[last] = list;
  }
  const table = newTable();
  list.push(table);
  return table;
}

function setPath(table: TomlTable, keys: string[], value: TomlValue): void {
  const parent = ensureTable(table, keys.slice(0, -1));
  const last = keys[keys.length - 1];
  if (!safeKey(last)) throw new Error("unsafe key");
  parent[last] = value;
}

export function parseTomlSubset(text: string): TomlTable {
  return new TomlReader(text).read();
}

function dig(table: TomlValue | undefined, ...keys: string[]): TomlValue | undefined {
  let cur: TomlValue | undefined = table;
  for (const k of keys) {
    if (!isTable(cur) || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function strings(v: TomlValue | undefined): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

/** `package-dir` mapping: `"" = "src"` is a root; `pkg = "lib/pkg"` is one when the directory is named `pkg`. */
function rootsFromPackageDir(map: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [name, dir] of Object.entries(map)) {
    if (name === "") out.push(dir);
    else if (!name.includes(".") && path.posix.basename(dir.replace(/\/+$/, "")) === name) {
      out.push(path.posix.dirname(dir.replace(/\/+$/, "")));
    }
  }
  return out;
}

function pyprojectRoots(doc: TomlTable): string[] {
  const out: string[] = [];
  const pd = dig(doc, "tool", "setuptools", "package-dir");
  if (isTable(pd)) {
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(pd)) if (typeof v === "string") map[k] = v;
    out.push(...rootsFromPackageDir(map));
  }
  out.push(...strings(dig(doc, "tool", "setuptools", "packages", "find", "where")));
  const poetry = dig(doc, "tool", "poetry", "packages");
  if (Array.isArray(poetry)) {
    for (const p of poetry) {
      if (isTable(p) && typeof p.from === "string") out.push(p.from);
    }
  }
  for (const pkg of strings(dig(doc, "tool", "hatch", "build", "targets", "wheel", "packages"))) {
    const dir = path.posix.dirname(pkg.replace(/\/+$/, ""));
    if (dir !== ".") out.push(dir);
  }
  out.push(...strings(dig(doc, "tool", "pdm", "build", "package-dir")));
  out.push(...strings(dig(doc, "tool", "maturin", "python-source")));
  out.push(...strings(dig(doc, "tool", "pytest", "ini_options", "pythonpath")));
  return out;
}

// ---------------------------------------------------------------------------
// setup.cfg (INI subset)
// ---------------------------------------------------------------------------

function parseIniSubset(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  let lastKey = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^\s*([#;].*)?$/.test(line)) continue;
    const header = /^\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      current = new Map();
      sections.set(header[1].trim(), current);
      lastKey = "";
      continue;
    }
    if (!current) continue;
    if (/^\s/.test(line) && lastKey) {
      current.set(lastKey, `${current.get(lastKey) ?? ""}\n${line.trim()}`);
      continue;
    }
    const kv = /^([^=:\s][^=:]*?)\s*[=:]\s*(.*)$/.exec(line);
    if (kv) {
      lastKey = kv[1].trim().toLowerCase();
      current.set(lastKey, kv[2].trim());
    }
  }
  return sections;
}

function setupCfgRoots(text: string): string[] {
  const sections = parseIniSubset(text);
  const out: string[] = [];
  const packageDir = sections.get("options")?.get("package_dir");
  if (packageDir) {
    const map: Record<string, string> = {};
    for (const entry of packageDir.split(/\n|,/)) {
      const m = /^\s*([\w.]*)\s*=\s*(\S+)\s*$/.exec(entry);
      if (m) map[m[1]] = m[2];
    }
    out.push(...rootsFromPackageDir(map));
  }
  const where = sections.get("options.packages.find")?.get("where");
  if (where) out.push(...where.split(/[\s,]+/).filter(Boolean));
  return out;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function readBounded(file: string): string | null {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** `dir` + `rel` as a normalised root-relative path, or null when it leaves the project. */
function joinInside(dir: string, rel: string): string | null {
  const clean = rel.replace(/\\/g, "/");
  if (clean.startsWith("/") || /^[A-Za-z]:/.test(clean)) return null;
  const parts: string[] = [];
  for (const seg of `${dir}/${clean}`.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Python source roots for the project: the defaults first, then those declared by
 * its configs (shallowest config first), without duplicates.
 */
export function buildPythonRoots(root: string, indexedPaths: Iterable<string>): string[] {
  const configs: Array<{ dir: string; kind: "pyproject" | "setup.cfg" }> = [];
  for (const rel of indexedPaths) {
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    if (base !== "pyproject.toml" && base !== "setup.cfg") continue;
    const dir = rel.lastIndexOf("/") < 0 ? "" : rel.slice(0, rel.lastIndexOf("/"));
    configs.push({ dir, kind: base === "pyproject.toml" ? "pyproject" : "setup.cfg" });
  }
  configs.sort(
    (a, b) =>
      a.dir.split("/").length - b.dir.split("/").length ||
      a.dir.localeCompare(b.dir) ||
      a.kind.localeCompare(b.kind)
  );

  const roots: string[] = [...DEFAULT_PYTHON_ROOTS];
  const add = (r: string | null): void => {
    if (r !== null && !roots.includes(r) && roots.length < MAX_PYTHON_ROOTS) roots.push(r);
  };
  for (const { dir, kind } of configs.slice(0, MAX_PYTHON_CONFIGS)) {
    // A package with its own config is a project root of its own.
    add(dir);
    add(joinInside(dir, "src"));
    const text = readBounded(
      path.join(root, dir, kind === "pyproject" ? "pyproject.toml" : "setup.cfg")
    );
    if (text === null) continue;
    let declared: string[] = [];
    try {
      declared = kind === "pyproject" ? pyprojectRoots(parseTomlSubset(text)) : setupCfgRoots(text);
    } catch {
      declared = [];
    }
    for (const d of declared) add(joinInside(dir, d));
  }
  return roots;
}
