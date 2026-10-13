import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import type { ProjectMeta, ProjectIndex } from "./types";

const SCHEMA_VERSION = 1;

export function getKaiHomeDir(): string {
  if (process.env.KAI_HOME) {
    return path.resolve(process.env.KAI_HOME);
  }
  if (process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, "kai");
  }
  return path.join(os.homedir(), ".kai");
}

export function getProjectsDir(): string {
  return path.join(getKaiHomeDir(), "projects");
}

export function getSessionsDir(): string {
  return path.join(getKaiHomeDir(), "sessions");
}

export function getCacheDir(): string {
  return path.join(getKaiHomeDir(), "cache");
}

export function normalizePathForIdentity(targetPath: string): string {
  let resolved = resolveCanonicalPath(targetPath);
  if (resolved.startsWith("\\\\?\\UNC\\")) {
    resolved = "\\\\" + resolved.slice(8);
  } else if (resolved.startsWith("\\\\?\\")) {
    resolved = resolved.slice(4);
  }
  resolved = resolved.replace(/\\/g, "/");
  while (resolved.length > 1 && resolved.endsWith("/")) {
    resolved = resolved.slice(0, -1);
  }
  if (process.platform === "win32" || process.platform === "darwin") {
    resolved = resolved.toLowerCase();
  }
  return resolved;
}

export function computeLegacyProjectId(canonicalPath: string): string {
  return crypto.createHash("sha256").update(canonicalPath).digest("hex").slice(0, 16);
}

export function computeProjectId(canonicalPath: string): string {
  const normalized = normalizePathForIdentity(canonicalPath);
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function isWithinProjectBoundary(targetPath: string, rootPath: string): boolean {
  const normTarget = normalizePathForIdentity(targetPath);
  const normRoot = normalizePathForIdentity(rootPath);
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
 * File lock with PID and timeout to prevent concurrent indexing corruption
 */
export class ProjectLock {
  private lockPath: string;
  private isAcquired: boolean = false;

  constructor(projectId: string) {
    this.lockPath = getProjectLockPath(projectId);
  }

  acquire(timeoutMs: number = 5000): boolean {
    const dir = path.dirname(this.lockPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const start = Date.now();
    const pid = process.pid;

    while (Date.now() - start < timeoutMs) {
      try {
        // Exclusive creation
        fs.writeFileSync(this.lockPath, JSON.stringify({ pid, time: Date.now() }), {
          flag: "wx",
          mode: 0o600,
        });
        this.isAcquired = true;
        return true;
      } catch (err: unknown) {
        // If file exists, check if stale (> 30s) or process dead or corrupted
        try {
          const content = fs.readFileSync(this.lockPath, "utf-8");
          let data: { pid?: number; time?: number } | null = null;
          try {
            data = JSON.parse(content);
          } catch {
            // Corrupt or partial lock file; mark null to unlink
            data = null;
          }

          const age = data && typeof data.time === "number" ? Date.now() - data.time : 999999;
          let isDead = false;
          if (data && typeof data.pid === "number") {
            try {
              process.kill(data.pid, 0); // Check if process exists
            } catch {
              isDead = true;
            }
          } else {
            isDead = true;
          }

          if (age > 30000 || isDead || !data) {
            fs.unlinkSync(this.lockPath);
            continue;
          }
        } catch {
          // If read/parse failed or file vanished, attempt retry or unlink
          try {
            if (fs.existsSync(this.lockPath)) {
              fs.unlinkSync(this.lockPath);
              continue;
            }
          } catch {
            // ignore
          }
        }

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
    }
    return false;
  }

  release(): void {
    if (this.isAcquired) {
      try {
        if (fs.existsSync(this.lockPath)) {
          fs.unlinkSync(this.lockPath);
        }
      } catch {
        // Ignore unlink error on release
      }
      this.isAcquired = false;
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
        // Update rootPath if alias was used
        existing.rootPath = projectPath;
        // If it was stuck in 'indexing' from an interrupted process, reset to ready or unindexed
        if (existing.status === "indexing") {
          const indexPath = getProjectIndexPath(existing.id);
          existing.status = fs.existsSync(indexPath) ? "ready" : "unindexed";
          existing.lastError = null;
        }
        atomicWriteJson(metaPath, existing);
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
  };

  atomicWriteJson(metaPath, meta);
  return meta;
}

export function cleanupDanglingTempFiles(storageDir: string): void {
  try {
    if (!fs.existsSync(storageDir)) return;
    const entries = fs.readdirSync(storageDir);
    for (const file of entries) {
      if (file.endsWith(".tmp")) {
        try {
          fs.rmSync(path.join(storageDir, file), { force: true });
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

export function saveProjectIndex(projectId: string, index: ProjectIndex): void {
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
    atomicWriteJson(getProjectMetaPath(projectId), meta);
  }

  cleanupDanglingTempFiles(getProjectStorageDir(projectId));
}

export function deleteProjectData(projectId: string): { success: boolean; error?: string } {
  // Strict allow-list: ids are 16 lowercase hex chars from computeProjectId.
  // This guards the recursive rmSync below against caller confusion such as
  // "../..", absolute paths, or empty strings.
  if (!/^[0-9a-f]{16}$/.test(projectId)) {
    return { success: false, error: "Invalid project id" };
  }
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
    fs.rmSync(storageDir, { recursive: true, force: true });
    return { success: true };
  } catch (err: unknown) {
    return { success: false, error: String(err) };
  }
}
