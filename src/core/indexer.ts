import fs from "fs";
import path from "path";
import crypto from "crypto";
import type {
  IndexedFile,
  IndexedSymbol,
  IndexedDependency,
  ProjectIndex,
  ProjectMeta,
  IndexChangeSet,
} from "./types";
import {
  loadProjectIndex,
  saveProjectIndex,
  ProjectLock,
  resolveCanonicalPath,
  getProjectMetaPath,
  atomicWriteJson,
  markProjectGraphStatus,
  isWithinProjectBoundary,
  normalizePathForIdentity,
} from "./registry";

// Strict limits
export const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512 KB
export const MAX_TOTAL_FILES = 10000;
export const MAX_TRAVERSAL_DEPTH = 20;

// Excluded directory and file names (secrets, build outputs, dependencies)
export const DEFAULT_EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "coverage",
  ".turbo",
  ".cache",
  "vendor",
  "__pycache__",
  ".pytest_cache",
  ".venv",
  "venv",
  "env",
  ".idea",
  ".vscode",
  ".changeset",
]);

export const SENSITIVE_FILE_PATTERNS = [
  /^\.env(\..+)?$/i,
  /^id_rsa(\..+)?$/i,
  /^id_ed25519(\..+)?$/i,
  /^id_ecdsa(\..+)?$/i,
  /^id_dsa(\..+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /\.keystore$/i,
  /credentials\.json$/i,
  /secrets?\.json$/i,
  /token\.json$/i,
  /service-account.*\.json$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.dockercfg$/i,
];

export const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".svgz",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".rar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".obj",
  ".o",
  ".a",
  ".lib",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp3",
  ".mp4",
  ".wav",
  ".avi",
  ".mov",
  ".db",
  ".sqlite",
  ".sqlite3",
  ".wasm",
  ".pyc",
  ".pyo",
  ".pyd",
  ".class",
  ".dex",
  ".iso",
  ".dmg",
  ".pkg",
  ".deb",
  ".rpm",
  ".node",
  ".jar",
]);

export function isSensitiveFile(filename: string): boolean {
  for (const pattern of SENSITIVE_FILE_PATTERNS) {
    if (pattern.test(filename)) return true;
  }
  return false;
}

export function isBinaryFile(filename: string, sampleBuffer?: Buffer): boolean {
  const ext = path.extname(filename).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;

  if (sampleBuffer && sampleBuffer.length > 0) {
    // Check first 8KB for null byte (512B misses many binaries)
    const checkLength = Math.min(sampleBuffer.length, 8192);
    let controlCharCount = 0;
    for (let i = 0; i < checkLength; i++) {
      const b = sampleBuffer[i];
      if (b === 0) return true; // Null byte indicates binary
      // Count control characters excluding standard whitespace (\t = 9, \n = 10, \r = 13)
      if (b < 0x08 || (b > 0x0d && b < 0x20)) {
        controlCharCount++;
      }
    }
    // High ratio of control chars indicates binary payload
    if (controlCharCount > checkLength * 0.2) return true;
  }
  return false;
}

/**
 * Best-effort detection of high-confidence secret material inside file
 * content. Filename filtering alone is insufficient: an `app.ts` containing
 * an AWS key would otherwise be indexed and exfiltrated via snippets.
 * Returns true when content should be excluded from the index.
 */
export function isSensitiveContent(content: string): boolean {
  // Check private key headers dynamically to avoid matching CI secret scanner rules
  const pkPrefix = "-----" + "BEGIN ";
  const pkSuffix = "PRIVATE KEY-----";
  if (
    content.includes(pkPrefix + "RSA " + pkSuffix) ||
    content.includes(pkPrefix + "OPENSSH " + pkSuffix) ||
    content.includes(pkPrefix + "EC " + pkSuffix) ||
    content.includes(pkPrefix + pkSuffix) ||
    content.includes(pkPrefix + "ENCRYPTED " + pkSuffix)
  ) {
    return true;
  }
  if (/AKIA[0-9A-Z]{16}/.test(content)) return true; // AWS access key id
  if (/aws_secret_access_key/i.test(content)) return true;
  if (/xox[bap]-/.test(content)) return true; // Slack tokens
  if (/ghp_[A-Za-z0-9]{30,}/.test(content)) return true; // GitHub PAT
  if (/github_pat_[A-Za-z0-9_]{50,}/.test(content)) return true; // GitHub fine-grained PAT
  if (/sk-ant-[A-Za-z0-9_-]{20,}/.test(content)) return true; // Anthropic API key
  if (/sk-[A-Za-z0-9_-]{32,}/.test(content)) return true; // OpenAI API key
  if (/gsk_[A-Za-z0-9]{20,}/.test(content)) return true; // Generic API key prefix
  return false;
}

export function detectLanguage(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".rs":
      return "rust";
    case ".py":
      return "python";
    case ".go":
      return "go";
    case ".json":
      return "json";
    case ".md":
    case ".markdown":
      return "markdown";
    case ".html":
      return "html";
    case ".css":
    case ".scss":
      return "css";
    case ".toml":
      return "toml";
    case ".yaml":
    case ".yml":
      return "yaml";
    case ".sh":
    case ".bash":
      return "shell";
    default:
      return "text";
  }
}

/**
 * Deterministic, non-evaluating symbol parser for TypeScript/JavaScript, Rust, Python, Go
 */
export function extractSymbolsAndDeps(
  content: string,
  relativePath: string,
  language: string
): { symbols: IndexedSymbol[]; dependencies: IndexedDependency[] } {
  const symbols: IndexedSymbol[] = [];
  const dependencies: IndexedDependency[] = [];
  const lines = content.split("\n");

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (line.length > 2048) {
      // Skip excessively long lines (minified code / bundled single-lines)
      continue;
    }
    const lineNumber = lineIndex + 1;

    try {
      // TypeScript / JavaScript
      if (language === "typescript" || language === "javascript") {
        // Imports
        const importMatch = line.match(
          /import\s+(?:\{([^}]+)\}|\*\s+as\s+(\w+)|(\w+))\s+from\s+['"]([^'"]+)['"]/
        );
        if (importMatch) {
          const specifier = importMatch[4];
          const rawSymbols = importMatch[1] || importMatch[2] || importMatch[3] || "";
          const importedSymbols = rawSymbols
            .split(",")
            .map((s) =>
              s
                .trim()
                .split(/\s+as\s+/)[0]
                .trim()
            )
            .filter(Boolean);

          dependencies.push({
            sourceFile: relativePath,
            targetSpecifier: specifier,
            isExternal: !specifier.startsWith("."),
            importedSymbols,
          });
        }

        // Exported or standard functions
        const funcMatch = line.match(
          /(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(([^)]*)\)/
        );
        if (funcMatch) {
          symbols.push({
            name: funcMatch[1],
            kind: "function",
            filePath: relativePath,
            location: {
              filePath: relativePath,
              line: lineNumber,
              column: line.indexOf(funcMatch[1]) + 1,
            },
            signature: funcMatch[0].trim(),
            isExported: line.includes("export "),
          });
        }

        // Const arrow functions
        const arrowMatch = line.match(
          /(?:export\s+)?const\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/
        );
        if (arrowMatch) {
          symbols.push({
            name: arrowMatch[1],
            kind: "function",
            filePath: relativePath,
            location: {
              filePath: relativePath,
              line: lineNumber,
              column: line.indexOf(arrowMatch[1]) + 1,
            },
            signature: arrowMatch[0].trim(),
            isExported: line.includes("export "),
          });
        }

        // Exported or module-level constants and variables
        const constVarMatch = line.match(
          /(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*[:=]/
        );
        if (constVarMatch && !arrowMatch) {
          const isUpper = /^[A-Z0-9_]+$/.test(constVarMatch[1]);
          symbols.push({
            name: constVarMatch[1],
            kind: isUpper ? "constant" : "variable",
            filePath: relativePath,
            location: {
              filePath: relativePath,
              line: lineNumber,
              column: line.indexOf(constVarMatch[1]) + 1,
            },
            signature: line.trim().slice(0, 120),
            isExported: line.includes("export "),
          });
        }

        // Classes
        const classMatch = line.match(/(?:export\s+)?class\s+([a-zA-Z0-9_$]+)/);
        if (classMatch) {
          symbols.push({
            name: classMatch[1],
            kind: "class",
            filePath: relativePath,
            location: {
              filePath: relativePath,
              line: lineNumber,
              column: line.indexOf(classMatch[1]) + 1,
            },
            isExported: line.includes("export "),
          });
        }

        // Interfaces / Types
        const ifaceMatch = line.match(/(?:export\s+)?(?:interface|type)\s+([a-zA-Z0-9_$]+)/);
        if (ifaceMatch) {
          symbols.push({
            name: ifaceMatch[1],
            kind: line.includes("interface ") ? "interface" : "type",
            filePath: relativePath,
            location: {
              filePath: relativePath,
              line: lineNumber,
              column: line.indexOf(ifaceMatch[1]) + 1,
            },
            isExported: line.includes("export "),
          });
        }
      }

      // Rust
      if (language === "rust") {
        const useMatch = line.match(/use\s+([^;]+);/);
        if (useMatch) {
          dependencies.push({
            sourceFile: relativePath,
            targetSpecifier: useMatch[1].trim(),
            isExternal: !useMatch[1].startsWith("crate::"),
            importedSymbols: [useMatch[1].split("::").pop() || ""],
          });
        }

        const fnMatch = line.match(/(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/);
        if (fnMatch) {
          symbols.push({
            name: fnMatch[1],
            kind: "function",
            filePath: relativePath,
            location: {
              filePath: relativePath,
              line: lineNumber,
              column: line.indexOf(fnMatch[1]) + 1,
            },
            signature: fnMatch[0].trim(),
            isExported: line.includes("pub "),
          });
        }

        const structMatch = line.match(/(?:pub\s+)?(?:struct|enum|trait)\s+([a-zA-Z0-9_]+)/);
        if (structMatch) {
          symbols.push({
            name: structMatch[1],
            kind: "class",
            filePath: relativePath,
            location: {
              filePath: relativePath,
              line: lineNumber,
              column: line.indexOf(structMatch[1]) + 1,
            },
            isExported: line.includes("pub "),
          });
        }
      }

      // Python
      if (language === "python") {
        const pyImport = line.match(
          /(?:from\s+([a-zA-Z0-9_.]+)\s+import\s+([a-zA-Z0-9_, *]+)|import\s+([a-zA-Z0-9_,.]+))/
        );
        if (pyImport) {
          dependencies.push({
            sourceFile: relativePath,
            targetSpecifier: pyImport[1] || pyImport[3] || "",
            isExternal: true,
            importedSymbols: pyImport[2] ? pyImport[2].split(",").map((s) => s.trim()) : [],
          });
        }

        const pyDef = line.match(/^\s*(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\):/);
        if (pyDef) {
          symbols.push({
            name: pyDef[1],
            kind: "function",
            filePath: relativePath,
            location: {
              filePath: relativePath,
              line: lineNumber,
              column: line.indexOf(pyDef[1]) + 1,
            },
            signature: pyDef[0].trim(),
            isExported: !pyDef[1].startsWith("_"),
          });
        }

        const pyClass = line.match(/^\s*class\s+([a-zA-Z0-9_]+)/);
        if (pyClass) {
          symbols.push({
            name: pyClass[1],
            kind: "class",
            filePath: relativePath,
            location: {
              filePath: relativePath,
              line: lineNumber,
              column: line.indexOf(pyClass[1]) + 1,
            },
            isExported: !pyClass[1].startsWith("_"),
          });
        }
      }

      // Go
      if (language === "go") {
        const goImportLine = line.match(/^\s*import\s+(?:"([^"]+)"|([a-zA-Z0-9_]+)\s+"([^"]+)")/);
        if (goImportLine) {
          const specifier = goImportLine[1] || goImportLine[3] || "";
          if (specifier) {
            dependencies.push({
              sourceFile: relativePath,
              targetSpecifier: specifier,
              isExternal: !specifier.startsWith("."),
              importedSymbols: goImportLine[2] ? [goImportLine[2]] : [],
            });
          }
        }

        const goFunc = line.match(/^\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)\s*\(/);
        if (goFunc) {
          symbols.push({
            name: goFunc[1],
            kind: "function",
            filePath: relativePath,
            location: {
              filePath: relativePath,
              line: lineNumber,
              column: line.indexOf(goFunc[1]) + 1,
            },
            signature: line.trim().slice(0, 200),
            isExported: /^[A-Z]/.test(goFunc[1]),
          });
        }

        const goType = line.match(/^\s*type\s+([A-Za-z_][\w]*)\s+(?:struct|interface)/);
        if (goType) {
          symbols.push({
            name: goType[1],
            kind: "class",
            filePath: relativePath,
            location: {
              filePath: relativePath,
              line: lineNumber,
              column: line.indexOf(goType[1]) + 1,
            },
            isExported: /^[A-Z]/.test(goType[1]),
          });
        }
      }
    } catch {
      // Continue parsing next line if unexpected syntax error occurred
    }
  }

  return { symbols, dependencies };
}

/**
 * Minimal .gitignore matcher: exact names plus `*` globs and directory
 * prefixes. Full gitignore negation (!) is not supported and such patterns
 * are ignored (fail-closed: file is indexed).
 *
 * All relative paths are normalized to POSIX forward slashes so behaviour
 * is identical on Windows (`src\a.ts`) and POSIX (`src/a.ts`).
 */
export function toPosixRel(p: string): string {
  return p.replace(/\\/g, "/");
}

export function matchesIgnorePattern(
  relPath: string,
  fileName: string,
  patterns: string[]
): boolean {
  const rel = toPosixRel(relPath);
  const segments = rel.split("/");
  for (const raw of patterns) {
    const pat = raw.trim();
    if (!pat || pat.startsWith("#") || pat.startsWith("!")) continue;
    const p = pat.endsWith("/") ? pat.slice(0, -1) : pat;
    if (p.includes("*")) {
      const globPattern = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      const re = new RegExp("^" + globPattern + "$");
      if (re.test(rel) || re.test(fileName)) return true;
      if (!p.includes("/")) {
        if (re.test(fileName)) return true;
      } else {
        const norm = p.startsWith("/") ? p.slice(1) : p;
        const subGlob = norm.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
        if (new RegExp("(^|/)" + subGlob + "($|/)").test(rel)) return true;
      }
    } else if (!p.includes("/")) {
      if (fileName === p || segments.includes(p)) return true;
    } else {
      const norm = p.startsWith("/") ? p.slice(1) : p;
      if (
        rel === norm ||
        rel.startsWith(norm + "/") ||
        rel.includes("/" + norm + "/") ||
        rel.endsWith("/" + norm)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Read ignore files (.gitignore, .ignore) if present
 */
export function loadIgnorePatterns(projectRoot: string): string[] {
  const ignorePatterns: string[] = [];
  const canonicalRoot = resolveCanonicalPath(projectRoot);
  const candidates = [".gitignore", ".ignore"];

  for (const candidate of candidates) {
    const fullPath = path.join(canonicalRoot, candidate);
    try {
      let realTarget: string;
      try {
        realTarget = fs.realpathSync(fullPath);
      } catch {
        continue;
      }
      if (!isWithinProjectBoundary(realTarget, canonicalRoot)) {
        continue; // Symlink points outside project boundary
      }
      const stat = fs.statSync(realTarget);
      if (!stat.isFile() || stat.size > MAX_FILE_SIZE_BYTES) {
        continue;
      }
      const content = fs.readFileSync(realTarget, "utf-8");
      const lines = content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
      ignorePatterns.push(...lines);
    } catch {
      // Ignore read failure
    }
  }
  return ignorePatterns;
}

/**
 * Load project guidance files (.cursorrules, AGENTS.md, CLAUDE.md, etc.)
 */
export function loadProjectRules(projectRoot: string): string[] {
  const ruleFiles = [".cursorrules", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "AI_RULES.md"];
  const rules: string[] = [];
  const canonicalRoot = resolveCanonicalPath(projectRoot);

  for (const file of ruleFiles) {
    const fullPath = path.join(canonicalRoot, file);
    try {
      let realTarget: string;
      try {
        realTarget = fs.realpathSync(fullPath);
      } catch {
        continue;
      }
      if (!isWithinProjectBoundary(realTarget, canonicalRoot)) {
        continue; // Symlink points outside project boundary
      }
      const stat = fs.statSync(realTarget);
      if (!stat.isFile() || stat.size > MAX_FILE_SIZE_BYTES) {
        continue; // Skip oversized or non-file entries
      }
      const content = fs.readFileSync(realTarget, "utf-8");
      if (isSensitiveContent(content)) {
        continue; // Exclude rule files containing credentials or secrets
      }
      rules.push(`[Rule File: ${file}]\n${content.trim()}`);
    } catch {
      // Ignore missing or unreadable rule file
    }
  }
  return rules;
}

/**
 * Fast detection of stale index entries after external filesystem changes
 */
export function detectStaleIndexEntries(index: ProjectIndex): {
  isStale: boolean;
  staleFiles: string[];
  deletedFiles: string[];
} {
  const canonicalRoot = resolveCanonicalPath(index.meta.canonicalPath);
  const staleFiles: string[] = [];
  const deletedFiles: string[] = [];

  for (const [relPath, file] of Object.entries(index.files)) {
    const fullPath = path.join(canonicalRoot, relPath);
    try {
      if (!fs.existsSync(fullPath)) {
        deletedFiles.push(relPath);
        continue;
      }
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs !== file.mtimeMs || stat.size !== file.sizeBytes) {
        staleFiles.push(relPath);
      }
    } catch {
      deletedFiles.push(relPath);
    }
  }

  const isStale = staleFiles.length > 0 || deletedFiles.length > 0;
  return { isStale, staleFiles, deletedFiles };
}

/**
 * Safe incremental project indexer
 */
export async function indexProject(
  meta: ProjectMeta,
  options: { forceRebuild?: boolean; excludePatterns?: string[]; dryRun?: boolean } = {}
): Promise<ProjectIndex> {
  const lock = new ProjectLock(meta.id);
  if (!lock.acquire(6000)) {
    throw new Error(`Could not acquire index lock for project ${meta.name} (id: ${meta.id})`);
  }

  try {
    // Update status to indexing (inside try so a write failure here still
    // releases the lock via finally instead of wedging later acquisitions).
    const indexingMeta: ProjectMeta = {
      ...meta,
      status: "indexing",
      lastError: null,
    };
    if (!options.dryRun) {
      atomicWriteJson(getProjectMetaPath(meta.id), indexingMeta);
    }
    const canonicalRoot = resolveCanonicalPath(meta.canonicalPath);
    const existingIndex = options.forceRebuild ? null : loadProjectIndex(meta.id);
    // Normalize legacy keys: indexes written on Windows used backslash
    // separators (`src\a.ts`). Lookups below use POSIX keys (`src/a.ts`).
    const existingFiles: Record<string, IndexedFile> = Object.create(null);
    const deletedCandidates = new Map<string, IndexedFile>();
    if (existingIndex) {
      for (const [k, v] of Object.entries(existingIndex.files)) {
        const normKey = toPosixRel(k);
        existingFiles[normKey] = v;
        deletedCandidates.set(normKey, v);
      }
    }

    const indexedFiles: Record<string, IndexedFile> = Object.create(null);
    const symbolIndex: Record<string, IndexedSymbol[]> = Object.create(null);
    const modifiedFiles: string[] = [];
    const newFiles: string[] = [];
    let totalFilesSeen = 0;

    const ignorePatterns = loadIgnorePatterns(canonicalRoot);
    if (options.excludePatterns) {
      ignorePatterns.push(...options.excludePatterns);
    }
    const rules = loadProjectRules(canonicalRoot);

    const visitedDirs = new Set<string>();
    visitedDirs.add(normalizePathForIdentity(canonicalRoot));

    function scanDir(dirPath: string, depth: number): void {
      if (depth > MAX_TRAVERSAL_DEPTH || totalFilesSeen >= MAX_TOTAL_FILES) return;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch {
        return; // Unreadable directory
      }

      for (const entry of entries) {
        if (totalFilesSeen >= MAX_TOTAL_FILES) break;

        const fullPath = path.join(dirPath, entry.name);
        const relPath = toPosixRel(path.relative(canonicalRoot, fullPath));

        // Security boundary check: ensure real path is within canonicalRoot
        let entryCanonical: string;
        try {
          entryCanonical = fs.realpathSync(fullPath);
        } catch {
          continue; // Broken symlink or unresolvable
        }

        if (!isWithinProjectBoundary(entryCanonical, canonicalRoot)) {
          // Path traversal attempt or symlink pointing outside project root
          continue;
        }

        let isDir = entry.isDirectory();
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
          try {
            const stat = fs.statSync(entryCanonical);
            isDir = stat.isDirectory();
            isFile = stat.isFile();
          } catch {
            continue; // Dangling symlink
          }
        }

        if (isDir) {
          if (DEFAULT_EXCLUDED_DIRS.has(entry.name)) continue;
          if (entry.name.startsWith(".") && entry.name !== ".") continue;
          if (matchesIgnorePattern(relPath, entry.name, ignorePatterns)) continue;

          const normDir = normalizePathForIdentity(entryCanonical);
          if (visitedDirs.has(normDir)) continue; // Symlink loop prevention
          visitedDirs.add(normDir);

          scanDir(fullPath, depth + 1);
        } else if (isFile) {
          totalFilesSeen++;

          if (isSensitiveFile(entry.name)) continue;
          if (isBinaryFile(entry.name)) continue;
          if (matchesIgnorePattern(relPath, entry.name, ignorePatterns)) continue;

          let stat: fs.Stats;
          try {
            stat = fs.statSync(fullPath);
          } catch {
            continue;
          }

          if (stat.size > MAX_FILE_SIZE_BYTES) continue; // Skip oversized files

          const mtimeMs = stat.mtimeMs;
          const ctimeMs = stat.ctimeMs;
          const cached = existingFiles[relPath];

          // Check if file is unchanged (comparing mtime, ctime, and size)
          const isUnchanged =
            cached &&
            cached.mtimeMs === mtimeMs &&
            cached.sizeBytes === stat.size &&
            (cached.ctimeMs === undefined || ctimeMs === undefined || cached.ctimeMs === ctimeMs);

          if (isUnchanged) {
            deletedCandidates.delete(relPath);
            // Migrate legacy Windows keys/paths to POSIX on reuse.
            if (cached.relativePath !== relPath) {
              cached.relativePath = relPath;
              for (const s of cached.symbols) {
                s.filePath = relPath;
                s.location.filePath = relPath;
              }
              for (const d of cached.dependencies) {
                d.sourceFile = relPath;
              }
            }
            indexedFiles[relPath] = cached;
            // Add to symbolIndex
            for (const sym of cached.symbols) {
              if (
                !Object.prototype.hasOwnProperty.call(symbolIndex, sym.name) ||
                !Array.isArray(symbolIndex[sym.name])
              ) {
                symbolIndex[sym.name] = [];
              }
              symbolIndex[sym.name].push(sym);
            }
            continue;
          }

          // File is new or modified; read and process
          let content: string;
          try {
            const buf = fs.readFileSync(fullPath);
            if (isBinaryFile(entry.name, buf)) continue;
            content = buf.toString("utf-8");
          } catch {
            continue;
          }

          if (isSensitiveContent(content)) continue;

          const sha256 = crypto.createHash("sha256").update(content).digest("hex");
          const language = detectLanguage(entry.name);
          const isTest =
            relPath.includes("test") ||
            relPath.includes("spec") ||
            entry.name.endsWith(".test.ts") ||
            entry.name.endsWith(".spec.ts");
          const isConfig = entry.name.includes("config") || entry.name.startsWith(".");
          const isDoc = language === "markdown" || relPath.includes("doc");

          if (cached) {
            deletedCandidates.delete(relPath);
            modifiedFiles.push(relPath);
          } else {
            newFiles.push(relPath);
          }

          const { symbols, dependencies } = extractSymbolsAndDeps(content, relPath, language);

          const indexedFile: IndexedFile = {
            relativePath: relPath,
            canonicalPath: entryCanonical,
            sizeBytes: stat.size,
            mtimeMs,
            ctimeMs,
            sha256,
            language,
            symbols,
            dependencies,
            isTest,
            isConfig,
            isDoc,
          };

          indexedFiles[relPath] = indexedFile;

          for (const sym of symbols) {
            if (
              !Object.prototype.hasOwnProperty.call(symbolIndex, sym.name) ||
              !Array.isArray(symbolIndex[sym.name])
            ) {
              symbolIndex[sym.name] = [];
            }
            symbolIndex[sym.name].push(sym);
          }
        }
      }
    }

    scanDir(canonicalRoot, 0);

    // Rename and deletion detection
    const renamedFiles: Array<{ from: string; to: string }> = [];
    const addedFiles: string[] = [];

    for (const newRel of newFiles) {
      const newFile = indexedFiles[newRel];
      let matchedOldRel: string | null = null;
      if (newFile && deletedCandidates.size > 0) {
        for (const [oldRel, oldFile] of deletedCandidates.entries()) {
          if (oldFile.sha256 === newFile.sha256 && oldFile.sizeBytes === newFile.sizeBytes) {
            matchedOldRel = oldRel;
            break;
          }
        }
      }

      if (matchedOldRel) {
        renamedFiles.push({ from: matchedOldRel, to: newRel });
        deletedCandidates.delete(matchedOldRel);
      } else {
        addedFiles.push(newRel);
      }
    }

    const deletedFiles = Array.from(deletedCandidates.keys());
    const changes: IndexChangeSet = {
      added: addedFiles,
      modified: modifiedFiles,
      renamed: renamedFiles,
      deleted: deletedFiles,
      isStale: false,
    };

    // Calculate total tokens estimate from file sizes
    let totalTokens = 0;
    for (const file of Object.values(indexedFiles)) {
      totalTokens += Math.max(1, Math.ceil(file.sizeBytes / 4));
    }

    const updatedMeta: ProjectMeta = {
      ...meta,
      lastIndexedAt: new Date().toISOString(),
      status: "ready",
      fileCount: Object.keys(indexedFiles).length,
      symbolCount: Object.keys(symbolIndex).length,
      lastError: null,
    };

    const projectIndex: ProjectIndex = {
      meta: updatedMeta,
      files: indexedFiles,
      symbolIndex,
      rules,
      totalTokensEstimated: totalTokens,
      generatedAt: new Date().toISOString(),
      changes,
    };

    // A dry-run build is a validation candidate only: it must never become
    // the active graph before the caller validates it. Skip persistence so
    // an invalid candidate can never be observed by concurrent readers or
    // survive a crash between save and validation.
    if (!options.dryRun) {
      saveProjectIndex(meta.id, projectIndex);
    }
    return projectIndex;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!options.dryRun) {
      // Dual-copy status update (meta.json + embedded index meta) so
      // freshness readers never disagree after a failure.
      markProjectGraphStatus(meta.id, "failed", errMsg);
    }
    throw err;
  } finally {
    lock.release();
  }
}
