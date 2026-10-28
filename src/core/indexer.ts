import fs from "fs";
import path from "path";
import crypto from "crypto";
import type {
  IndexedFile,
  IndexedSymbol,
  ProjectIndex,
  ProjectMeta,
  IndexChangeSet,
  SkippedFileRecord,
  SkipReason,
  ScanSummary,
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
  normalizeCanonicalForIdentity,
  newProjectIncarnation,
  SCHEMA_VERSION,
} from "./registry";
import { extractSymbolsAndDeps, EXTRACTOR_VERSION } from "./symbolExtractor";
import { resolveAllDependencies } from "./importResolver";
import { buildAliasLookup } from "./tsconfigAliases";
import { buildPythonLayout } from "./pythonRoots";
import { buildGoModules, buildRustCrates } from "./rustGoModules";

// Re-exported so existing importers of the extractor keep working.
export { extractSymbolsAndDeps, EXTRACTOR_VERSION };

// Strict limits
const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512 KB
/** Files indexed per project unless `KAI_MAX_INDEX_FILES` says otherwise. */
export const DEFAULT_MAX_TOTAL_FILES = 10000;
/** Bounds for `KAI_MAX_INDEX_FILES`: a value outside is clamped, not rejected. */
export const MIN_ENV_MAX_TOTAL_FILES = 100;
/** Ceiling for any cap (env or option): the index is one JSON snapshot loaded whole. */
export const HARD_MAX_TOTAL_FILES = 50000;
const MAX_TRAVERSAL_DEPTH = 20;

/**
 * The file-count cap for a scan: `KAI_MAX_INDEX_FILES` when it is a whole number
 * (clamped to `MIN_ENV_MAX_TOTAL_FILES`..`HARD_MAX_TOTAL_FILES`), else the default.
 * Anything that is not a plain decimal integer is ignored rather than guessed at.
 */
export function resolveMaxTotalFiles(raw: string | undefined = process.env.KAI_MAX_INDEX_FILES) {
  const text = raw?.trim();
  if (!text || !/^\d{1,9}$/.test(text)) return DEFAULT_MAX_TOTAL_FILES;
  return Math.min(Math.max(Number(text), MIN_ENV_MAX_TOTAL_FILES), HARD_MAX_TOTAL_FILES);
}
/** How long a failed read is remembered before the file is read again. */
const UNREADABLE_RETRY_MS = 60_000;

/**
 * True when a skip record still describes the file on disk. Compares only
 * stat metadata (size, mtime, and ctime when both sides carry it), so any
 * edit, replacement or permission change invalidates the record and the
 * file is inspected again.
 */
export function skipRecordMatches(
  rec: SkippedFileRecord | undefined,
  stat: { size: number; mtimeMs: number; ctimeMs?: number },
  nowMs: number = Date.now()
): boolean {
  if (!rec) return false;
  // A failed read can be transient (a lock held by an editor or antivirus), so
  // unlike a content verdict it is retried once the record is old enough.
  if (rec.reason === "unreadable") {
    if (rec.recordedAtMs === undefined || nowMs - rec.recordedAtMs > UNREADABLE_RETRY_MS) {
      return false;
    }
  }
  if (rec.sizeBytes !== stat.size || rec.mtimeMs !== stat.mtimeMs) return false;
  if (rec.ctimeMs !== undefined && stat.ctimeMs !== undefined && rec.ctimeMs !== stat.ctimeMs) {
    return false;
  }
  return true;
}

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

const SENSITIVE_FILE_PATTERNS = [
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

const BINARY_EXTENSIONS = new Set([
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
  // OpenAI API key. The leading lookbehind keeps the prefix a real token
  // start: without it any long kebab-case word ending in "sk" (e.g.
  // "task-management-and-scheduling-service-config") matched and silently
  // dropped the whole file. Keys such as `sk-proj-...`, `"sk-..."` and
  // `KEY=sk-...` still match because they are not preceded by a word char.
  if (/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{32,}/.test(content)) return true;
  if (/gsk_[A-Za-z0-9]{20,}/.test(content)) return true; // Generic API key prefix
  return false;
}

function detectLanguage(filename: string): string {
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
 * Files whose mtime/ctime fall within this window before the index snapshot
 * was stamped are "racily clean" (the git term): a same-size edit landing in
 * the same coarse filesystem timestamp tick would be invisible to a
 * mtime/size/ctime comparison, so their content hash is re-verified instead.
 * 2 s covers FAT-style granularity; the rest is slack for hashing lag during
 * the build. The set is bounded by RACY_REHASH_MAX_FILES per check.
 */
const RACY_TIMESTAMP_WINDOW_MS = 5000;
const RACY_REHASH_MAX_FILES = 200;

/**
 * Fast detection of stale index entries after external filesystem changes.
 *
 * Covers modified/deleted tracked files (mtime/size/ctime, plus a content
 * re-hash for racily-clean files so a same-size edit with a preserved or
 * coarse timestamp is still caught), case-only renames (realpath basename
 * mismatch on case-insensitive filesystems), and untracked new files
 * (bounded readdir-only walk with the same exclusion rules as the indexer,
 * so excluded files never mark stale).
 */
export function detectStaleIndexEntries(index: ProjectIndex): {
  isStale: boolean;
  staleFiles: string[];
  deletedFiles: string[];
  newFiles: string[];
  /**
   * The snapshot's own scan stopped at the file-count cap, so files beyond it
   * are unindexed by design and cannot be told apart from new files. New-file
   * detection is skipped (it would otherwise report "new" forever and force a
   * rebuild on every read); callers must surface the incomplete scan.
   */
  scanIncomplete: boolean;
  /**
   * The snapshot's symbols came from an older extractor revision. This counts
   * as stale so one refresh re-extracts every file; the rebuilt snapshot
   * carries the current revision and the check then settles.
   */
  extractorOutdated: boolean;
} {
  const canonicalRoot = resolveCanonicalPath(index.meta.canonicalPath);
  const staleFiles: string[] = [];
  const deletedFiles: string[] = [];
  const snapshotMs = Date.parse(index.generatedAt);
  let racyRehashes = 0;

  // Directory listings, read once per directory, for the case-only-rename check
  // below (a realpath per file costs ~7x a stat on Windows and dominated the
  // whole freshness check).
  const dirListings = new Map<string, Set<string> | null>();
  const onDiskNameMatches = (full: string): boolean => {
    const dir = path.dirname(full);
    let names = dirListings.get(dir);
    if (names === undefined) {
      try {
        names = new Set(fs.readdirSync(dir));
      } catch {
        names = null;
      }
      dirListings.set(dir, names);
    }
    // An unreadable directory cannot disprove the name (the stat above already succeeded).
    return names === null || names.has(path.basename(full));
  };

  for (const [relPath, file] of Object.entries(index.files)) {
    const fullPath = path.join(canonicalRoot, relPath);
    try {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        deletedFiles.push(relPath);
        continue;
      }
      if (stat.mtimeMs !== file.mtimeMs || stat.size !== file.sizeBytes) {
        staleFiles.push(relPath);
        continue;
      }
      // ctime cannot be set by user-space tools, so it exposes edits that
      // restored mtime (e.g. `touch -r`, utimes) at the same size.
      if (
        file.ctimeMs !== undefined &&
        stat.ctimeMs !== undefined &&
        stat.ctimeMs !== file.ctimeMs
      ) {
        staleFiles.push(relPath);
        continue;
      }
      // Racily clean: timestamps too close to the snapshot to prove the
      // content is unchanged, so compare the actual bytes.
      if (
        Number.isFinite(snapshotMs) &&
        snapshotMs - Math.max(file.mtimeMs, file.ctimeMs ?? 0) < RACY_TIMESTAMP_WINDOW_MS &&
        racyRehashes < RACY_REHASH_MAX_FILES
      ) {
        racyRehashes++;
        try {
          const live = crypto
            .createHash("sha256")
            .update(fs.readFileSync(fullPath, "utf-8"))
            .digest("hex");
          if (live !== file.sha256) {
            staleFiles.push(relPath);
            continue;
          }
        } catch {
          staleFiles.push(relPath);
          continue;
        }
      }
      // Case-only rename on case-insensitive filesystems: the old key still
      // stats but the on-disk spelling differs. (Comparing against the real
      // directory listing also means a symlinked file is not mistaken for a
      // rename, which a basename-of-realpath comparison did.)
      if (!onDiskNameMatches(fullPath)) {
        staleFiles.push(relPath);
      }
    } catch {
      deletedFiles.push(relPath);
    }
  }

  let newFiles: string[] = [];
  const scanIncomplete = index.scan?.fileLimitReached === true;
  if (!scanIncomplete) {
    try {
      newFiles = detectUntrackedNewFiles(canonicalRoot, index);
    } catch {
      newFiles = [];
    }
  }

  const extractorOutdated = index.extractorVersion !== EXTRACTOR_VERSION;
  // A capped snapshot is rebuilt once when the user has since raised the cap
  // through KAI_MAX_INDEX_FILES (an explicit setting only: the default cannot
  // tell a snapshot capped by a caller's option from one capped by the default).
  // The rebuilt snapshot records the new limit, so this settles.
  const capRaised =
    scanIncomplete &&
    process.env.KAI_MAX_INDEX_FILES !== undefined &&
    resolveMaxTotalFiles() > (index.scan?.fileLimit ?? 0);
  const isStale =
    staleFiles.length > 0 ||
    deletedFiles.length > 0 ||
    newFiles.length > 0 ||
    extractorOutdated ||
    capRaised;
  return { isStale, staleFiles, deletedFiles, newFiles, scanIncomplete, extractorOutdated };
}

/**
 * Bounded readdir-only scan for files present on disk that the index does
 * not track. Mirrors the indexer's exclusion rules (excluded dirs, dot
 * dirs, .gitignore patterns, sensitive names, binary extensions, size cap)
 * without reading file contents, so excluded files never report stale.
 * Collects at most 50 entries; finding even one proves staleness.
 */
function detectUntrackedNewFiles(
  canonicalRoot: string,
  index: ProjectIndex,
  limit: number = 50
): string[] {
  const found: string[] = [];
  const ignorePatterns = loadIgnorePatterns(canonicalRoot);
  // Visit directories in the same order, and dedupe them under the same
  // identity key, as the indexer's own walk. A directory reachable by two
  // paths (a link into the project) is then claimed by the same path in both
  // walks, so a file the indexer reached through the link is not reported as
  // new because this walk met the real directory first.
  const visited = new Set<string>();
  visited.add(normalizeCanonicalForIdentity(canonicalRoot));

  const walk = (dir: string, canonicalDir: string, depth: number): void => {
    if (depth > MAX_TRAVERSAL_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      const fullPath = path.join(dir, entry.name);
      let rel: string;
      try {
        rel = toPosixRel(path.relative(canonicalRoot, fullPath));
      } catch {
        continue;
      }
      if (!rel || rel.startsWith("..")) continue;
      // Only a symlink (a junction counts as one) can lead outside the root, so
      // only its target is resolved and boundary-checked here, exactly as the
      // indexer does. A real entry of a directory already verified to be inside
      // the root is inside it too, and its canonical path is the parent's plus
      // its own name: no realpath (the dominant cost of this walk). The walk
      // never descends into a link that fails the check.
      let canonical: string;
      if (entry.isSymbolicLink()) {
        try {
          canonical = fs.realpathSync(fullPath);
        } catch {
          continue;
        }
        if (!isWithinProjectBoundary(canonical, canonicalRoot)) continue;
      } else {
        canonical = path.join(canonicalDir, entry.name);
      }
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const st = fs.statSync(canonical);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        if (DEFAULT_EXCLUDED_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.name !== ".") continue;
        if (matchesIgnorePattern(rel, entry.name, ignorePatterns)) continue;
        const key = normalizeCanonicalForIdentity(canonical);
        if (visited.has(key)) continue;
        visited.add(key);
        walk(fullPath, canonical, depth + 1);
      } else if (isFile) {
        // Tracked files were already stat-checked above; only unknown files need a look.
        if (Object.prototype.hasOwnProperty.call(index.files, rel)) continue;
        if (isSensitiveFile(entry.name)) continue;
        if (isBinaryFile(entry.name)) continue;
        if (matchesIgnorePattern(rel, entry.name, ignorePatterns)) continue;
        let st: fs.Stats;
        try {
          st = fs.statSync(fullPath);
        } catch {
          continue;
        }
        if (st.size > MAX_FILE_SIZE_BYTES) continue;
        // A file the indexer already inspected and rejected on content
        // (secret, binary, unreadable) is not "new" while its stat metadata
        // is unchanged; any change makes it new again so it is reconsidered.
        const rec =
          index.skipped && Object.prototype.hasOwnProperty.call(index.skipped, rel)
            ? index.skipped[rel]
            : undefined;
        if (skipRecordMatches(rec, st)) continue;
        found.push(rel);
      }
    }
  };
  walk(canonicalRoot, canonicalRoot, 0);
  return found;
}

/**
 * Safe incremental project indexer
 */
export async function indexProject(
  meta: ProjectMeta,
  options: {
    forceRebuild?: boolean;
    excludePatterns?: string[];
    dryRun?: boolean;
    /** File-count cap for this scan (tests and constrained callers); overrides `KAI_MAX_INDEX_FILES`, never above HARD_MAX_TOTAL_FILES. */
    maxTotalFiles?: number;
  } = {}
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
    // Symbols written by an older extractor are re-extracted (the file is
    // re-read) even when its stat metadata is unchanged. That is a
    // reprocessing pass, not a content change, so it is not reported as
    // `modified`.
    const extractorCurrent = existingIndex?.extractorVersion === EXTRACTOR_VERSION;
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

    // Skip records from the previous snapshot (stat-only memos of files that
    // were inspected and rejected on content). Honoured only while the file's
    // stat metadata is unchanged; a forced rebuild forgets them.
    const existingSkipped: Record<string, SkippedFileRecord> =
      existingIndex && existingIndex.skipped && typeof existingIndex.skipped === "object"
        ? existingIndex.skipped
        : Object.create(null);

    const indexedFiles: Record<string, IndexedFile> = Object.create(null);
    const symbolIndex: Record<string, IndexedSymbol[]> = Object.create(null);
    const skipped: Record<string, SkippedFileRecord> = Object.create(null);
    const modifiedFiles: string[] = [];
    const newFiles: string[] = [];
    let totalFilesSeen = 0;
    const requestedCap =
      options.maxTotalFiles !== undefined && Number.isFinite(options.maxTotalFiles)
        ? options.maxTotalFiles
        : resolveMaxTotalFiles();
    const fileCap = Math.min(Math.max(1, Math.floor(requestedCap)), HARD_MAX_TOTAL_FILES);
    let fileLimitReached = false;
    let depthLimitReached = false;
    let unreadableDirs = 0;

    const ignorePatterns = loadIgnorePatterns(canonicalRoot);
    if (options.excludePatterns) {
      ignorePatterns.push(...options.excludePatterns);
    }
    const rules = loadProjectRules(canonicalRoot);

    const visitedDirs = new Set<string>();
    visitedDirs.add(normalizePathForIdentity(canonicalRoot));

    function scanDir(dirPath: string, depth: number, canonicalDir: string): void {
      // Every early exit below leaves part of the tree unvisited; each one is
      // recorded in the scan summary so a partial scan is never reported as
      // complete.
      if (depth > MAX_TRAVERSAL_DEPTH) {
        depthLimitReached = true;
        return;
      }
      if (totalFilesSeen >= fileCap) {
        fileLimitReached = true;
        return;
      }

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch {
        unreadableDirs++;
        return; // Unreadable directory
      }

      for (const entry of entries) {
        if (totalFilesSeen >= fileCap) {
          // Entries that would have been excluded anyway do not make the
          // scan partial; anything else left unvisited does.
          if (DEFAULT_EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
          fileLimitReached = true;
          break;
        }

        const fullPath = path.join(dirPath, entry.name);
        const relPath = toPosixRel(path.relative(canonicalRoot, fullPath));

        // Security boundary check: ensure real path is within canonicalRoot.
        // Only a symlink (a junction counts as one) can lead somewhere else, so
        // only its target is resolved. A real entry of a directory already
        // verified to be inside the root is inside it too, and its canonical
        // path is the parent's canonical path plus its own name: realpathSync
        // on every entry was the dominant cost of a build on Windows.
        let entryCanonical: string;
        if (entry.isSymbolicLink()) {
          try {
            entryCanonical = fs.realpathSync(fullPath);
          } catch {
            continue; // Broken symlink or unresolvable
          }
        } else {
          entryCanonical = path.join(canonicalDir, entry.name);
        }

        if (entry.isSymbolicLink() && !isWithinProjectBoundary(entryCanonical, canonicalRoot)) {
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

          const normDir = normalizeCanonicalForIdentity(entryCanonical);
          if (visitedDirs.has(normDir)) continue; // Symlink loop prevention
          visitedDirs.add(normDir);

          scanDir(fullPath, depth + 1, entryCanonical);
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
          const statUnchanged =
            cached &&
            cached.mtimeMs === mtimeMs &&
            cached.sizeBytes === stat.size &&
            (cached.ctimeMs === undefined || ctimeMs === undefined || cached.ctimeMs === ctimeMs);
          const isUnchanged = statUnchanged && extractorCurrent;

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

          // A file rejected on content in an earlier build is not re-read while
          // its stat metadata is unchanged (it is not "new", just skipped).
          const prevSkip = Object.prototype.hasOwnProperty.call(existingSkipped, relPath)
            ? existingSkipped[relPath]
            : undefined;
          if (skipRecordMatches(prevSkip, stat)) {
            skipped[relPath] = prevSkip as SkippedFileRecord;
            continue;
          }

          const recordSkip = (reason: SkipReason): void => {
            skipped[relPath] = {
              reason,
              sizeBytes: stat.size,
              mtimeMs,
              ...(ctimeMs !== undefined ? { ctimeMs } : {}),
              ...(reason === "unreadable" ? { recordedAtMs: Date.now() } : {}),
            };
          };

          // File is new or modified; read and process
          let content: string;
          try {
            const buf = fs.readFileSync(fullPath);
            if (isBinaryFile(entry.name, buf)) {
              recordSkip("binary_content");
              continue;
            }
            content = buf.toString("utf-8");
          } catch {
            recordSkip("unreadable");
            continue;
          }

          if (isSensitiveContent(content)) {
            recordSkip("sensitive_content");
            continue;
          }

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
            if (!statUnchanged) modifiedFiles.push(relPath);
          } else {
            newFiles.push(relPath);
          }

          const { symbols, dependencies } = extractSymbolsAndDeps(content, relPath, language);
          // A trailing newline ends the last line; it does not start another.
          const lineCount =
            content.length === 0
              ? 0
              : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);

          const indexedFile: IndexedFile = {
            relativePath: relPath,
            canonicalPath: entryCanonical,
            sizeBytes: stat.size,
            mtimeMs,
            ctimeMs,
            sha256,
            language,
            lineCount,
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

    scanDir(canonicalRoot, 0, canonicalRoot);

    // Import targets depend on which other files exist, so they are resolved
    // for every file on every build (also for reused cache entries): a target
    // added or deleted elsewhere changes the answer.
    const pythonLayout = buildPythonLayout(canonicalRoot, Object.keys(indexedFiles));
    resolveAllDependencies(
      indexedFiles,
      buildAliasLookup(canonicalRoot, Object.keys(indexedFiles)),
      pythonLayout.roots,
      {
        rustCrates: buildRustCrates(canonicalRoot, Object.keys(indexedFiles)),
        go: buildGoModules(canonicalRoot, Object.keys(indexedFiles)),
        pythonPackages: pythonLayout.packageDirs,
      }
    );

    // Rename and deletion detection: one pass over the deletion candidates
    // keyed by content hash (first candidate in scan order wins, as before).
    const renamedFiles: Array<{ from: string; to: string }> = [];
    const addedFiles: string[] = [];
    const deletedByContent = new Map<string, string[]>();
    for (const [oldRel, oldFile] of deletedCandidates.entries()) {
      const key = `${oldFile.sha256}:${oldFile.sizeBytes}`;
      const bucket = deletedByContent.get(key);
      if (bucket) bucket.push(oldRel);
      else deletedByContent.set(key, [oldRel]);
    }

    for (const newRel of newFiles) {
      const newFile = indexedFiles[newRel];
      let matchedOldRel: string | null = null;
      if (newFile) {
        const bucket = deletedByContent.get(`${newFile.sha256}:${newFile.sizeBytes}`);
        while (bucket && bucket.length > 0 && matchedOldRel === null) {
          const candidate = bucket.shift() as string;
          if (deletedCandidates.has(candidate)) matchedOldRel = candidate;
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
    const skippedByReason: Partial<Record<SkipReason, number>> = {};
    for (const rec of Object.values(skipped)) {
      skippedByReason[rec.reason] = (skippedByReason[rec.reason] ?? 0) + 1;
    }
    const scan: ScanSummary = {
      complete: !fileLimitReached && !depthLimitReached && unreadableDirs === 0,
      fileLimitReached,
      fileLimit: fileCap,
      depthLimitReached,
      unreadableDirs,
      skippedByReason,
    };
    const changes: IndexChangeSet = {
      added: addedFiles,
      modified: modifiedFiles,
      renamed: renamedFiles,
      deleted: deletedFiles,
      isStale: false,
      skippedCount: Object.keys(skipped).length,
    };

    // Calculate total tokens estimate from file sizes
    let totalTokens = 0;
    for (const file of Object.values(indexedFiles)) {
      totalTokens += Math.max(1, Math.ceil(file.sizeBytes / 4));
    }

    const nowIso = new Date().toISOString();
    // One shared snapshot id for this build: stamped on the embedded meta
    // and the top-level index so saveProjectIndex can pair both
    // persistence copies unambiguously (timestamps alone are not robust).
    const snapshotId = newProjectIncarnation();
    const updatedMeta: ProjectMeta = {
      ...meta,
      // A rebuild normalizes the schema: a persisted snapshot with an
      // unknown future version is recovered into the version this build
      // writes, so consistency can converge instead of failing forever.
      schemaVersion: SCHEMA_VERSION,
      lastIndexedAt: nowIso,
      status: "ready",
      fileCount: Object.keys(indexedFiles).length,
      symbolCount: Object.keys(symbolIndex).length,
      lastError: null,
      snapshotId,
    };

    const projectIndex: ProjectIndex = {
      meta: updatedMeta,
      files: indexedFiles,
      symbolIndex,
      rules,
      totalTokensEstimated: totalTokens,
      generatedAt: nowIso,
      changes,
      skipped,
      scan,
      extractorVersion: EXTRACTOR_VERSION,
      snapshotId,
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
