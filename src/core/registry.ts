import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import type { ProjectMeta, ProjectIndex } from "./types";

export const SCHEMA_VERSION = 1;

export function getKaiHomeDir(): string {
  if (process.env.KAI_HOME) {
    return path.resolve(process.env.KAI_HOME);
  }
  if (process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, "kai");
  }
  return path.join(os.homedir(), ".kai");
}

function getProjectsDir(): string {
  return path.join(getKaiHomeDir(), "projects");
}

export function getSessionsDir(): string {
  return path.join(getKaiHomeDir(), "sessions");
}

export function getCacheDir(): string {
  return path.join(getKaiHomeDir(), "cache");
}

export function normalizePathForIdentity(targetPath: string, platform?: string): string {
  return normalizeCanonicalForIdentity(resolveCanonicalPath(targetPath), platform);
}

/**
 * Identity form (separators, trailing slash, case folding) of a path that is
 * ALREADY canonical. `normalizePathForIdentity` resolves the path first, which
 * costs one `lstat` per path component; callers that built the path from a
 * canonical parent (the indexer's directory walk) skip that.
 */
export function normalizeCanonicalForIdentity(canonicalPath: string, platform?: string): string {
  let resolved = canonicalPath;
  if (resolved.startsWith("\\\\?\\UNC\\")) {
    resolved = "\\\\" + resolved.slice(8);
  } else if (resolved.startsWith("\\\\?\\")) {
    resolved = resolved.slice(4);
  }
  resolved = resolved.replace(/\\/g, "/");
  while (resolved.length > 1 && resolved.endsWith("/")) {
    resolved = resolved.slice(0, -1);
  }
  const effectivePlatform = platform ?? process.platform;
  if (effectivePlatform === "win32" || effectivePlatform === "darwin") {
    resolved = resolved.toLowerCase();
  }
  return resolved;
}

function computeLegacyProjectId(canonicalPath: string): string {
  return crypto.createHash("sha256").update(canonicalPath).digest("hex").slice(0, 16);
}

export function computeProjectId(canonicalPath: string, platform?: string): string {
  const normalized = normalizePathForIdentity(canonicalPath, platform);
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function isWithinProjectBoundary(
  targetPath: string,
  rootPath: string,
  platform?: string
): boolean {
  const normTarget = normalizePathForIdentity(targetPath, platform);
  const normRoot = normalizePathForIdentity(rootPath, platform);
  if (normTarget === normRoot) return true;
  return normTarget.startsWith(normRoot + "/");
}

export function resolveCanonicalPath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Why `canonicalRoot` is too broad to index as one project: the user's home
 * directory, a filesystem or drive root, or a directory that contains the home
 * directory. An agent started there would have its first tool call index
 * everything beneath it. Returns null for an ordinary project folder, or when
 * `KAI_ALLOW_BROAD_ROOT=1` says the user really wants this.
 */
export function describeBroadRoot(
  canonicalRoot: string,
  opts: { home?: string; env?: NodeJS.ProcessEnv } = {}
): string | null {
  if ((opts.env ?? process.env).KAI_ALLOW_BROAD_ROOT === "1") return null;
  if (path.dirname(canonicalRoot) === canonicalRoot) return "a filesystem root";
  const home = resolveCanonicalPath(opts.home ?? os.homedir());
  if (normalizeCanonicalForIdentity(canonicalRoot) === normalizeCanonicalForIdentity(home)) {
    return "your home directory";
  }
  if (isWithinProjectBoundary(home, canonicalRoot))
    return "a folder that contains your home directory";
  return null;
}

export function ensureKaiDirectories(): void {
  const dirs = [getKaiHomeDir(), getProjectsDir(), getSessionsDir(), getCacheDir()];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
}

export function getProjectStorageDir(projectId: string): string {
  return path.join(getProjectsDir(), projectId);
}

/**
 * Mint a fresh project-registration incarnation token. Called for every
 * newly created registration (including re-registration at the same path
 * after the previous registration was deleted). The stable project id
 * (hash of the canonical path) is intentionally NOT enough on its own:
 * without this token an older in-flight task could publish into a newly
 * registered project at the same path.
 */
export function newProjectIncarnation(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return crypto.randomBytes(16).toString("hex");
  }
}

function ensureIncarnation(meta: ProjectMeta): ProjectMeta {
  if (typeof meta.incarnation !== "string" || !meta.incarnation) {
    meta.incarnation = newProjectIncarnation();
  }
  return meta;
}

export function getProjectMetaPath(projectId: string): string {
  return path.join(getProjectStorageDir(projectId), "meta.json");
}

export function getProjectIndexPath(projectId: string): string {
  return path.join(getProjectStorageDir(projectId), "index.json");
}

export function getProjectLockPath(projectId: string): string {
  return path.join(getProjectStorageDir(projectId), ".lock");
}

/**
 * Atomic file writer using temporary file and atomic rename.
 * Retries the rename on Windows transient locks (EPERM/EBUSY/EACCES from
 * AV scanners or lingering handles) so the same code passes on
 * Linux, macOS, and Windows.
 */
export function atomicWriteJson(targetPath: string, data: unknown): void {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const tmpPath = `${targetPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const serialized = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmpPath, serialized, { mode: 0o600, encoding: "utf-8" });
  const attempts = process.platform === "win32" ? 8 : 1;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fs.renameSync(tmpPath, targetPath);
      return;
    } catch (err: unknown) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      const retryable = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!retryable || attempt === attempts - 1) break;
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      } catch {
        // Atomics.wait unavailable; fall through to immediate retry.
      }
    }
  }
  try {
    fs.rmSync(tmpPath, { force: true });
  } catch {
    // Ignore cleanup failure; surface the original rename error below.
  }
  throw lastError;
}

/**
 * A live holder that has not refreshed the lock for this long is presumed hung
 * (or its PID was recycled by an unrelated process after a crash). A holder
 * whose PID is gone is reclaimed immediately, whatever the lock's age.
 */
const LOCK_STALE_MS = 120_000;
/** A lock file that is empty or unparseable this young is a holder mid-write, not a corpse. */
const LOCK_PARTIAL_GRACE_MS = 3_000;
/** Minimum spacing between mtime refreshes by a long-running holder. */
const LOCK_HEARTBEAT_MS = 5_000;

type LockState = { kind: "free" } | { kind: "held" } | { kind: "stale"; raw: string };

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Classify the lock file without modifying it. */
function inspectLock(lockPath: string): LockState {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = fs.readFileSync(lockPath, "utf-8");
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { kind: "free" };
    // Present but unreadable right now (AV scan, sharing violation): treat as held.
    return { kind: "held" };
  }
  const age = Date.now() - mtimeMs;
  let pid: unknown;
  try {
    pid = (JSON.parse(raw) as { pid?: unknown } | null)?.pid;
  } catch {
    pid = undefined;
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return age < LOCK_PARTIAL_GRACE_MS ? { kind: "held" } : { kind: "stale", raw };
  }
  if (!pidIsAlive(pid)) return { kind: "stale", raw };
  return age > LOCK_STALE_MS ? { kind: "stale", raw } : { kind: "held" };
}

/** True while another live process holds the project lock (it is building or publishing the index). */
export function isProjectLockHeld(projectId: string): boolean {
  return inspectLock(getProjectLockPath(projectId)).kind === "held";
}

/**
 * Remove a lock judged stale. The content is re-read first so a lock another
 * process has just taken over from the same corpse is never deleted by us.
 * (Not airtight; the window is a single read-to-unlink gap on an advisory lock.)
 */
function removeStaleLock(lockPath: string, raw: string): boolean {
  try {
    if (fs.readFileSync(lockPath, "utf-8") !== raw) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    // Vanished or locked: the next attempt re-inspects.
    return false;
  }
}

/**
 * Advisory per-project lock (`.lock` in the storage dir) that serializes index
 * builds and publishes across processes.
 *
 * - Created with `wx` and written + fsynced while the file is exclusively ours;
 *   a reader that races the write sees an empty file, which counts as held
 *   while young instead of being "cleaned up" under the new owner.
 * - Each acquisition writes a unique token; `release` and `touch` act only on a
 *   lock that still carries it, so a holder whose lock was reclaimed can never
 *   delete or refresh its successor's.
 * - Long holders call `touch` to refresh the mtime. The indexer's scan is
 *   synchronous, so a timer could never fire during it; it calls `touch` from
 *   inside the scan loop instead.
 */
export class ProjectLock {
  private lockPath: string;
  private token: string | null = null;
  private lastBeatMs = 0;

  constructor(projectId: string) {
    this.lockPath = getProjectLockPath(projectId);
  }

  acquire(timeoutMs: number = 5000): boolean {
    const dir = path.dirname(this.lockPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const start = Date.now();
    const token = newProjectIncarnation();
    const body = JSON.stringify({ pid: process.pid, token, time: Date.now() });

    while (Date.now() - start < timeoutMs) {
      try {
        const fd = fs.openSync(this.lockPath, "wx", 0o600);
        try {
          fs.writeSync(fd, body);
          fs.fsyncSync(fd);
        } catch (err: unknown) {
          // Never leave an empty lock behind for the next process to wait out.
          fs.closeSync(fd);
          fs.rmSync(this.lockPath, { force: true });
          throw err;
        }
        fs.closeSync(fd);
        this.token = token;
        this.lastBeatMs = Date.now();
        return true;
      } catch (err: unknown) {
        // EEXIST is contention. EPERM/EACCES/EBUSY is what Windows reports
        // while a just-unlinked lock is still open elsewhere (delete pending).
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") {
          throw err;
        }
      }

      const state = inspectLock(this.lockPath);
      // A reclaimed lock is retried at once; everything else waits a beat.
      if (state.kind === "stale" && removeStaleLock(this.lockPath, state.raw)) continue;

      // Sleep briefly without burning CPU (busy-spin blocked the event loop)
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      } catch {
        // Fallback if Atomics.wait is unavailable
        const sleepUntil = Date.now() + 50;
        while (Date.now() < sleepUntil) {
          // spin
        }
      }
    }
    return false;
  }

  /** Whether the lock file still carries this acquisition's token (unreadable counts as ours). */
  private ownsLockFile(): boolean {
    if (!this.token) return false;
    try {
      const data = JSON.parse(fs.readFileSync(this.lockPath, "utf-8")) as {
        token?: unknown;
      } | null;
      return data?.token === this.token;
    } catch (err: unknown) {
      // Gone: someone reclaimed it. Anything else (locked, mid-rewrite): do not guess.
      return (err as NodeJS.ErrnoException)?.code !== "ENOENT";
    }
  }

  /**
   * Heartbeat for a long-running holder: refreshes the lock's mtime (at most
   * every few seconds, so it is cheap to call in a hot loop). Returns false
   * once the lock is no longer ours.
   */
  touch(): boolean {
    if (!this.token) return false;
    const now = Date.now();
    if (now - this.lastBeatMs < LOCK_HEARTBEAT_MS) return true;
    this.lastBeatMs = now;
    if (!this.ownsLockFile()) return false;
    try {
      fs.utimesSync(this.lockPath, now / 1000, now / 1000);
    } catch {
      // A missed beat only shortens the grace period; never fail the build over it.
    }
    return true;
  }

  /** True while this instance holds the lock and no one has reclaimed it. */
  isHeld(): boolean {
    return this.ownsLockFile();
  }

  release(): void {
    if (!this.token) return;
    const owned = this.ownsLockFile();
    this.token = null;
    if (!owned) return;
    try {
      fs.unlinkSync(this.lockPath);
    } catch {
      // Ignore unlink error on release
    }
  }
}

/**
 * Register or look up a project by path
 */
export function registerProject(projectPath: string): ProjectMeta {
  ensureKaiDirectories();
  const canonicalPath = resolveCanonicalPath(projectPath);

  if (!fs.existsSync(canonicalPath)) {
    throw new Error(`Project path does not exist: ${projectPath}`);
  }
  const stat = fs.statSync(canonicalPath);
  if (!stat.isDirectory()) {
    throw new Error(`Project path is not a directory: ${projectPath}`);
  }

  const id = computeProjectId(canonicalPath);
  const name = path.basename(canonicalPath) || "root";
  const metaPath = getProjectMetaPath(id);

  if (fs.existsSync(metaPath)) {
    try {
      const raw = fs.readFileSync(metaPath, "utf-8");
      const existing = JSON.parse(raw);
      if (
        typeof existing === "object" &&
        existing !== null &&
        typeof existing.id === "string" &&
        typeof existing.canonicalPath === "string" &&
        typeof existing.status === "string"
      ) {
        // Only rewrite meta.json when a field actually changes: every MCP call
        // registers the project, and an unconditional rewrite made each plain
        // read an atomic write.
        const before = JSON.stringify(existing);
        // Update rootPath if alias was used
        existing.rootPath = projectPath;
        // Stuck in 'indexing' from an interrupted process: reset to ready or
        // unindexed. Not while a live process still holds the project lock,
        // though: that build is real, and resetting its status here would let
        // readers treat a half-written index as settled.
        if (existing.status === "indexing" && !isProjectLockHeld(existing.id)) {
          const indexPath = getProjectIndexPath(existing.id);
          existing.status = fs.existsSync(indexPath) ? "ready" : "unindexed";
          existing.lastError = null;
        }
        // Incarnation stability: an idempotent re-lookup of a still-live
        // registration keeps its token (concurrent MCP reads must not
        // invalidate each other). A registration created after a delete
        // takes the fresh-token path below. Legacy metadata without a
        // token is upgraded here — an old in-flight task captured before
        // the upgrade carries no token and is rejected by
        // verifyProjectIdentity, never silently adopted.
        ensureIncarnation(existing);
        if (JSON.stringify(existing) !== before) {
          atomicWriteJson(metaPath, existing);
        }
        // The abandoned-temp sweep stays unconditional (a cheap readdir): a
        // registration is the recovery point after an interrupted write.
        cleanupDanglingTempFiles(getProjectStorageDir(id));
        return existing as ProjectMeta;
      }
    } catch {
      // Corrupt meta; recreate
    }
  }

  const meta: ProjectMeta = {
    id,
    name,
    rootPath: projectPath,
    canonicalPath,
    registeredAt: new Date().toISOString(),
    lastIndexedAt: null,
    schemaVersion: SCHEMA_VERSION,
    status: "unindexed",
    fileCount: 0,
    symbolCount: 0,
    lastError: null,
    // Fresh registration (including re-registration at the same path
    // after a delete): mint a new incarnation so stale in-flight tasks
    // captured under the previous registration cannot publish here.
    incarnation: newProjectIncarnation(),
  };

  atomicWriteJson(metaPath, meta);
  cleanupDanglingTempFiles(getProjectStorageDir(id));
  return meta;
}

/**
 * Remove abandoned `*.tmp` files left by an interrupted `atomicWriteJson`.
 * Only files older than `maxAgeMs` are removed so a concurrent writer's
 * fresh temp file in another process is never deleted from under it.
 */
function cleanupDanglingTempFiles(storageDir: string, maxAgeMs: number = 60000): void {
  try {
    if (!fs.existsSync(storageDir)) return;
    const entries = fs.readdirSync(storageDir);
    const now = Date.now();
    for (const file of entries) {
      if (file.endsWith(".tmp")) {
        const full = path.join(storageDir, file);
        try {
          const stat = fs.statSync(full);
          if (Number.isFinite(stat.mtimeMs) && now - stat.mtimeMs < maxAgeMs) continue;
          fs.rmSync(full, { force: true });
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
}

export function getProjectMeta(projectIdOrPath: string): ProjectMeta | null {
  ensureKaiDirectories();
  // 1. Direct ID lookup if 16 hex chars
  if (/^[0-9a-f]{16}$/.test(projectIdOrPath)) {
    const metaPath = getProjectMetaPath(projectIdOrPath);
    if (fs.existsSync(metaPath)) {
      try {
        const raw = fs.readFileSync(metaPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof parsed.id === "string" &&
          typeof parsed.canonicalPath === "string" &&
          typeof parsed.status === "string"
        ) {
          return parsed as ProjectMeta;
        }
      } catch {
        // ignore
      }
    }
  }

  // 2. Normalized path ID lookup
  const canonical = resolveCanonicalPath(projectIdOrPath);
  const id = computeProjectId(canonical);
  const metaPath = getProjectMetaPath(id);
  if (fs.existsSync(metaPath)) {
    try {
      const raw = fs.readFileSync(metaPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof parsed.id === "string" &&
        typeof parsed.canonicalPath === "string" &&
        typeof parsed.status === "string"
      ) {
        return parsed as ProjectMeta;
      }
    } catch {
      // ignore
    }
  }

  // 3. Fallback: legacy un-normalized hash lookup
  const legacyId = computeLegacyProjectId(canonical);
  if (legacyId !== id) {
    const legacyMetaPath = getProjectMetaPath(legacyId);
    if (fs.existsSync(legacyMetaPath)) {
      try {
        const raw = fs.readFileSync(legacyMetaPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof parsed.id === "string" &&
          typeof parsed.canonicalPath === "string" &&
          typeof parsed.status === "string"
        ) {
          return parsed as ProjectMeta;
        }
      } catch {
        // ignore
      }
    }
  }

  // 4. Fallback: match by equivalent normalized canonical path across registered projects
  // (handles case-insensitivity on Windows/macOS, symlink aliases, and trailing slashes)
  const targetNorm = normalizePathForIdentity(canonical);
  const allProjects = listRegisteredProjects();
  for (const proj of allProjects) {
    if (normalizePathForIdentity(proj.canonicalPath) === targetNorm) {
      return proj;
    }
  }

  return null;
}

export function listRegisteredProjects(): ProjectMeta[] {
  ensureKaiDirectories();
  const projectsDir = getProjectsDir();
  const result: ProjectMeta[] = [];

  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const metaPath = path.join(projectsDir, entry.name, "meta.json");
      if (fs.existsSync(metaPath)) {
        try {
          const raw = fs.readFileSync(metaPath, "utf-8");
          const meta = JSON.parse(raw);
          if (
            typeof meta === "object" &&
            meta !== null &&
            typeof meta.id === "string" &&
            typeof meta.canonicalPath === "string"
          ) {
            result.push(meta as ProjectMeta);
          }
        } catch {
          // Ignore corrupt entry
        }
      }
    }
  }

  return result;
}

export function loadProjectIndex(projectId: string): ProjectIndex | null {
  const indexPath = getProjectIndexPath(projectId);
  if (!fs.existsSync(indexPath)) return null;
  try {
    const raw = fs.readFileSync(indexPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.meta !== "object" ||
      parsed.meta === null ||
      typeof parsed.meta.id !== "string" ||
      typeof parsed.meta.canonicalPath !== "string" ||
      typeof parsed.files !== "object" ||
      parsed.files === null ||
      Array.isArray(parsed.files) ||
      typeof parsed.symbolIndex !== "object" ||
      parsed.symbolIndex === null ||
      Array.isArray(parsed.symbolIndex)
    ) {
      return null;
    }
    return parsed as ProjectIndex;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// In-process cache of parsed indexes (read paths only)
// ---------------------------------------------------------------------------
//
// Parsing a multi-megabyte index.json dominated repeated MCP reads. The cache
// is keyed by project id and validated on every use against the index file's
// stat signature (size, mtime, ctime, inode): the atomic temp+rename write path
// replaces the file, so any rewrite by this or another process changes the
// signature and the next read misses. Entries are frozen so one request can
// never mutate what another sees; they hold no source text; the cache is
// bounded in entries and estimated memory. `loadProjectIndex` stays an
// uncached, mutable load for writers (the indexer reuses and edits its copy).

interface IndexCacheEntry {
  signature: string;
  index: ProjectIndex;
  cost: number;
}

const INDEX_CACHE_MAX_ENTRIES = 3;
const INDEX_CACHE_MAX_COST_BYTES = 96 * 1024 * 1024;
/** Parsed JS objects take several times the bytes of the JSON text. */
const INDEX_CACHE_COST_FACTOR = 4;
const indexCache = new Map<string, IndexCacheEntry>();
let indexCacheHits = 0;
let indexCacheMisses = 0;

function indexFileSignature(indexPath: string): { signature: string; size: number } | null {
  try {
    const st = fs.statSync(indexPath);
    return {
      signature: `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`,
      size: st.size,
    };
  } catch {
    return null;
  }
}

function deepFreeze<T>(root: T): T {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) continue;
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      stack.push((value as Record<string, unknown>)[key]);
    }
  }
  return root;
}

/** Drop cached parses for one project (or all). Called by every writer for this project's files. */
export function invalidateIndexCache(projectId?: string): void {
  if (projectId === undefined) indexCache.clear();
  else indexCache.delete(projectId);
}

export function getIndexCacheStats(): { hits: number; misses: number; entries: number } {
  return { hits: indexCacheHits, misses: indexCacheMisses, entries: indexCache.size };
}

/**
 * Load the index for read-only use. The returned object is deeply frozen and
 * shared across calls while the file is unchanged: never mutate it.
 */
export function loadProjectIndexShared(projectId: string): {
  index: ProjectIndex | null;
  cache: "hit" | "miss";
} {
  const indexPath = getProjectIndexPath(projectId);
  const sig = indexFileSignature(indexPath);
  if (!sig) {
    indexCache.delete(projectId);
    return { index: null, cache: "miss" };
  }
  const hit = indexCache.get(projectId);
  if (hit && hit.signature === sig.signature && hit.index.meta.id === projectId) {
    // Re-insert so the Map's insertion order tracks recency.
    indexCache.delete(projectId);
    indexCache.set(projectId, hit);
    indexCacheHits++;
    return { index: hit.index, cache: "hit" };
  }
  indexCacheMisses++;
  indexCache.delete(projectId);
  const parsed = loadProjectIndex(projectId);
  if (!parsed) return { index: null, cache: "miss" };
  const frozen = deepFreeze(parsed);
  const cost = sig.size * INDEX_CACHE_COST_FACTOR;
  if (cost <= INDEX_CACHE_MAX_COST_BYTES) {
    indexCache.set(projectId, { signature: sig.signature, index: frozen, cost });
    let total = 0;
    for (const e of indexCache.values()) total += e.cost;
    for (const key of indexCache.keys()) {
      if (indexCache.size <= INDEX_CACHE_MAX_ENTRIES && total <= INDEX_CACHE_MAX_COST_BYTES) break;
      if (key === projectId) continue; // never evict the entry just loaded
      total -= indexCache.get(key)?.cost ?? 0;
      indexCache.delete(key);
    }
  }
  return { index: frozen, cache: "miss" };
}

/**
 * Publish an index (`index.json`, then `meta.json`). Callers hold the project
 * lock: `indexProject` does, and so does the graph-sync publish step.
 */
export function saveProjectIndex(projectId: string, index: ProjectIndex): void {
  invalidateIndexCache(projectId);
  // Pair both persistence copies with one shared snapshot id before the
  // two sequential renames: a crash between them leaves mismatched ids
  // that checkPersistenceConsistency detects. Legacy candidates without
  // an id are stamped here so the pair always matches after a save.
  const snapshotId =
    typeof index.snapshotId === "string" && index.snapshotId
      ? index.snapshotId
      : newProjectIncarnation();
  index.snapshotId = snapshotId;
  if (!index.meta || typeof index.meta !== "object") {
    throw new Error("saveProjectIndex refused: candidate has no meta");
  }
  index.meta.snapshotId = snapshotId;

  const indexPath = getProjectIndexPath(projectId);
  atomicWriteJson(indexPath, index);

  // Update meta
  const meta = getProjectMeta(projectId);
  if (meta) {
    meta.lastIndexedAt = index.generatedAt;
    meta.status = "ready";
    meta.fileCount = Object.keys(index.files).length;
    meta.symbolCount = Object.keys(index.symbolIndex).length;
    meta.lastError = null;
    meta.snapshotId = snapshotId;
    if (typeof index.meta.incarnation === "string" && index.meta.incarnation) {
      meta.incarnation = index.meta.incarnation;
    } else {
      ensureIncarnation(meta);
    }
    atomicWriteJson(getProjectMetaPath(projectId), meta);
  }

  cleanupDanglingTempFiles(getProjectStorageDir(projectId));
  invalidateIndexCache(projectId);
}

/** How long a status mark waits for the project lock before giving up. */
const STATUS_MARK_LOCK_WAIT_MS = 1000;

/**
 * Best-effort status transition applied to BOTH metadata copies: the
 * standalone `meta.json` and the `meta` embedded in `index.json`. Readers
 * use either copy (`getProjectMeta` vs `loadProjectIndex`), so updating only
 * one leaves freshness reporting inconsistent (e.g. meta.json says `stale`
 * while the loaded index still reports `fresh`). Both writes are atomic;
 * failures are swallowed so stale-marking never throws.
 *
 * Rewriting `index.json` is a read-modify-write of a multi-megabyte file, so
 * it runs under the project lock: unlocked, it could overwrite an index a
 * concurrent build had just published with the older copy it read. When
 * another live process holds the lock (a build is running) nothing is written
 * and `false` is returned; that build publishes both copies itself, and
 * on-disk drift is detected independently of this flag. Pass `lockHeld` when
 * the caller already holds the lock (the lock is not re-entrant).
 */
export function markProjectGraphStatus(
  projectId: string,
  status: "stale" | "failed",
  lastError?: string,
  opts: { lockHeld?: boolean } = {}
): boolean {
  invalidateIndexCache(projectId);
  // A deleted project has nothing to mark; locking would recreate its directory.
  if (!fs.existsSync(getProjectStorageDir(projectId))) return false;
  const lock = opts.lockHeld ? null : new ProjectLock(projectId);
  try {
    if (lock && !lock.acquire(STATUS_MARK_LOCK_WAIT_MS)) return false;
  } catch {
    return false; // best effort; never throw from status-marking
  }
  try {
    try {
      const metaPath = getProjectMetaPath(projectId);
      const raw = fs.readFileSync(metaPath, "utf-8");
      const meta = JSON.parse(raw);
      if (typeof meta === "object" && meta !== null) {
        meta.status = status;
        if (lastError !== undefined) meta.lastError = lastError;
        atomicWriteJson(metaPath, meta);
      }
    } catch {
      // best effort; never throw from status-marking
    }
    try {
      const indexPath = getProjectIndexPath(projectId);
      if (!fs.existsSync(indexPath)) return true;
      const raw = fs.readFileSync(indexPath, "utf-8");
      const index = JSON.parse(raw);
      if (typeof index !== "object" || index === null) return true;
      if (typeof index.meta !== "object" || index.meta === null) return true;
      index.meta.status = status;
      if (lastError !== undefined) index.meta.lastError = lastError;
      try {
        atomicWriteJson(indexPath, index);
      } catch {
        // Transient write failure (e.g. file-table pressure under parallel
        // load): one immediate retry before giving up best-effort.
        atomicWriteJson(indexPath, index);
      }
    } catch {
      // best effort; never throw from status-marking
    }
    return true;
  } finally {
    lock?.release();
  }
}

/**
 * Crash-consistency check for the dual-copy persistence (`meta.json` plus
 * the `meta` embedded in `index.json`). `saveProjectIndex` performs two
 * sequential atomic renames; a crash between them leaves the copies
 * disagreeing. Returns inconsistent with a reason when the next refresh
 * should rebuild; consistent when either copy is missing (nothing to
 * compare) or they agree. Legacy snapshots without snapshot ids fall back
 * to the timestamp-skew check and remain loadable.
 *
 * Validated, in order: readability of both copies, project id, canonical
 * path identity, incarnation pairing (when both copies carry one),
 * schema compatibility, status agreement, shared snapshot agreement
 * (when present), timestamp sanity and skew cross-checks, and required index
 * structure. Missing, truncated, or malformed JSON is inconsistent.
 *
 * Guarantee: every write is atomic at the single-file level (temp file +
 * rename), startup never crashes on partial state (`registerProject`
 * resets a stuck `indexing` status; corrupt JSON is recreated), and any
 * mismatch detected here forces a safe rebuild on the next refresh rather
 * than reporting `fresh`. No new storage format was introduced: the
 * snapshot id is an additive optional field.
 */
export function checkPersistenceConsistency(projectId: string): {
  consistent: boolean;
  reason?: string;
} {
  try {
    const metaPath = getProjectMetaPath(projectId);
    const indexPath = getProjectIndexPath(projectId);
    if (!fs.existsSync(metaPath) || !fs.existsSync(indexPath)) return { consistent: true };
    let meta: Record<string, unknown>;
    let index: Record<string, unknown>;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      // The (large) index copy is read-only here: reuse the parsed, frozen
      // cache entry when index.json's stat signature is unchanged instead of
      // re-parsing it on every freshness check. meta.json is always re-read.
      const sig = indexFileSignature(indexPath);
      const cached = sig ? indexCache.get(projectId) : undefined;
      if (sig && cached && cached.signature === sig.signature) {
        index = cached.index as unknown as Record<string, unknown>;
      } else {
        index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
      }
    } catch {
      return { consistent: false, reason: "persistence copy is truncated or malformed JSON" };
    }
    const embedded = (index as Record<string, unknown>)?.meta as Record<string, unknown> | null;
    if (!meta || typeof meta !== "object" || !embedded || typeof embedded !== "object") {
      return { consistent: false, reason: "unreadable persistence copy" };
    }
    if (typeof meta.id !== "string" || typeof embedded.id !== "string") {
      return { consistent: false, reason: "unreadable persistence copy" };
    }
    if (meta.id !== embedded.id) {
      return { consistent: false, reason: "project id mismatch between meta.json and index.json" };
    }
    if (projectId !== meta.id) {
      return {
        consistent: false,
        reason: "project id mismatch between storage directory and meta.json",
      };
    }
    // Project identity: both copies must describe the same canonical root.
    // A same-path re-registration after a delete keeps the path but mints
    // a new incarnation (checked below), so path equality alone never
    // validates a pairing — it only catches cross-project corruption.
    if (typeof meta.canonicalPath === "string" && typeof embedded.canonicalPath === "string") {
      try {
        if (
          normalizePathForIdentity(meta.canonicalPath) !==
          normalizePathForIdentity(embedded.canonicalPath)
        ) {
          return { consistent: false, reason: "canonical path mismatch between copies" };
        }
      } catch {
        return { consistent: false, reason: "unreadable persistence copy" };
      }
    }
    // Incarnation pairing: when both copies carry a token they must agree.
    // Absent tokens mean a legacy snapshot, which stays loadable via the
    // fallback checks below (stale-task protection for legacy metadata is
    // enforced separately by verifyProjectIdentity, not here).
    const outerInc = meta.incarnation;
    const innerInc = embedded.incarnation;
    if (
      typeof outerInc === "string" &&
      outerInc &&
      typeof innerInc === "string" &&
      innerInc &&
      outerInc !== innerInc
    ) {
      return {
        consistent: false,
        reason: "project incarnation mismatch (likely partial write across re-registration)",
      };
    }
    if (typeof meta.schemaVersion === "number" && typeof embedded.schemaVersion === "number") {
      if (meta.schemaVersion !== embedded.schemaVersion) {
        return { consistent: false, reason: "schema version mismatch" };
      }
    }
    if (typeof meta.schemaVersion === "number" && meta.schemaVersion !== SCHEMA_VERSION) {
      return {
        consistent: false,
        reason: `unsupported schema version ${String(meta.schemaVersion)}`,
      };
    }
    if (meta.status !== embedded.status) {
      return { consistent: false, reason: `status mismatch (meta.json=${meta.status})` };
    }
    // Shared snapshot agreement: the unambiguous pairing signal. When
    // neither copy carries one (legacy), fall through to timestamps.
    const outerSnap = meta.snapshotId;
    const innerSnap = embedded.snapshotId;
    const topSnap = (index as Record<string, unknown>)?.snapshotId;
    const snaps = [outerSnap, innerSnap, topSnap].filter(
      (s): s is string => typeof s === "string" && s.length > 0
    );
    if (snaps.length > 0) {
      const first = snaps[0];
      if (!snaps.every((s) => s === first)) {
        return {
          consistent: false,
          reason: "snapshot generation mismatch (likely partial write)",
        };
      }
      // All present ids agree. Timestamps are still cross-checked below as
      // fail-closed defense in depth: skew can only force an extra safe
      // rebuild (which converges), never a false `fresh`.
    }
    const outerTs = meta.lastIndexedAt as string | null;
    const innerTs = embedded.lastIndexedAt as string | null;
    const genTs = (index as Record<string, unknown>)?.generatedAt as string | null;
    for (const ts of [outerTs, innerTs, genTs]) {
      if (ts !== null && ts !== undefined && Number.isNaN(Date.parse(ts))) {
        return { consistent: false, reason: "invalid timestamp in persistence copy" };
      }
    }
    if (outerTs && genTs) {
      const skew = Math.abs(Date.parse(genTs) - Date.parse(outerTs));
      if (!Number.isFinite(skew) || skew > 5000) {
        return {
          consistent: false,
          reason: "generation timestamp mismatch (likely partial write)",
        };
      }
    }
    // Required index structure: a structurally invalid index must never
    // back a `fresh` report, even when the metadata copies agree.
    const files = (index as Record<string, unknown>)?.files;
    const symbolIndex = (index as Record<string, unknown>)?.symbolIndex;
    if (
      typeof files !== "object" ||
      files === null ||
      Array.isArray(files) ||
      typeof symbolIndex !== "object" ||
      symbolIndex === null ||
      Array.isArray(symbolIndex)
    ) {
      return { consistent: false, reason: "index structure invalid" };
    }
    return { consistent: true };
  } catch {
    return { consistent: false, reason: "persistence read failure" };
  }
}

/**
 * Files Kai writes for the index itself. The rest of a project's storage dir
 * (`integration.json`, the Azure DevOps binding) is the user's configuration,
 * not index data, and must survive removing the index.
 */
const INDEX_OWNED_FILES = new Set(["meta.json", "index.json", ".lock"]);
const INDEX_TEMP_FILE = /^(meta|index)\.json\..*\.tmp$/;

/**
 * Delete a project's index artifacts (`meta.json`, `index.json`, `.lock` and
 * abandoned temp files) and the storage dir itself once nothing else lives in
 * it. Other files, such as the project's integration binding, are left alone.
 */
export function deleteProjectData(projectId: string): { success: boolean; error?: string } {
  // Strict allow-list: ids are 16 lowercase hex chars from computeProjectId.
  // This guards the recursive rmSync below against caller confusion such as
  // "../..", absolute paths, or empty strings.
  if (!/^[0-9a-f]{16}$/.test(projectId)) {
    return { success: false, error: "Invalid project id" };
  }
  invalidateIndexCache(projectId);
  const storageDir = getProjectStorageDir(projectId);
  const resolvedBase = path.resolve(getProjectsDir());
  const resolvedTarget = path.resolve(storageDir);
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
    return { success: false, error: "Refusing to delete outside the projects directory" };
  }
  if (resolvedTarget === resolvedBase) {
    return { success: false, error: "Refusing to delete the projects directory itself" };
  }
  if (!fs.existsSync(storageDir)) {
    return { success: false, error: "Project data not found" };
  }
  try {
    for (const name of fs.readdirSync(storageDir)) {
      if (INDEX_OWNED_FILES.has(name) || INDEX_TEMP_FILE.test(name)) {
        fs.rmSync(path.join(storageDir, name), { force: true });
      }
    }
    if (fs.readdirSync(storageDir).length === 0) fs.rmdirSync(storageDir);
    return { success: true };
  } catch (err: unknown) {
    return { success: false, error: String(err) };
  }
}
