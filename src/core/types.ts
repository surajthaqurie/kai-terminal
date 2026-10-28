export type TaskCategory =
  | "explain"
  | "implement"
  | "debug"
  | "refactor"
  | "test"
  | "review"
  | "architecture"
  | "documentation"
  | "unknown";

export interface ClassificationResult {
  category: TaskCategory;
  confidence: number; // 0.0 - 1.0
  reason: string;
  isOverridden: boolean;
  detectedKeywords: string[];
}

export type IndexStatus = "unindexed" | "indexing" | "ready" | "stale" | "failed";

export interface ProjectMeta {
  id: string; // SHA-256 of canonical path
  name: string;
  rootPath: string; // Original registered path
  canonicalPath: string; // Resolved realpath
  registeredAt: string; // ISO timestamp
  lastIndexedAt: string | null;
  schemaVersion: number;
  status: IndexStatus;
  fileCount: number;
  symbolCount: number;
  lastError?: string | null;
  /**
   * Unique registration incarnation token (UUID). Minted fresh for every
   * newly created registration — including re-registration at the same
   * path after a delete — and preserved across idempotent re-lookups.
   * In-flight tasks capture this value at start; publishing paths reject
   * a task whose captured incarnation no longer matches the registry, so
   * a stale task can never publish into a newly registered project.
   * Optional because persisted metadata from older versions predates it.
   */
  incarnation?: string | null;
  /**
   * Shared snapshot identifier (UUID) pairing `meta.json` with the `meta`
   * embedded in `index.json` (and the top-level `ProjectIndex.snapshotId`).
   * Both copies are stamped with the same id on every save; a crash
   * between the two sequential renames leaves mismatched ids that
   * `checkPersistenceConsistency` detects. Optional for legacy snapshots.
   */
  snapshotId?: string | null;
}

export interface SymbolLocation {
  filePath: string;
  /** 1-based first line of the declaration (including a wrapped signature). */
  line: number;
  column: number;
  /** 1-based last line of the declaration body, when the extractor could determine it. */
  endLine?: number;
}

export interface IndexedSymbol {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "variable" | "constant" | "module";
  filePath: string;
  location: SymbolLocation;
  signature?: string;
  isExported: boolean;
  docstring?: string;
  /** Enclosing class / impl / type for methods (e.g. `Foo` for `Foo.bar`). */
  container?: string;
}

/**
 * Why `resolvedPath` is empty. `resolved` means it is set. `unresolved` is a
 * relative specifier whose target is not an indexed file. `non-relative` is a
 * package or path alias (alias maps such as tsconfig `paths` are NOT
 * resolved). `unsupported` marks languages without a resolver.
 */
export type DependencyResolution = "resolved" | "unresolved" | "non-relative" | "unsupported";

export interface IndexedDependency {
  sourceFile: string;
  targetSpecifier: string;
  resolvedPath?: string | null;
  resolution?: DependencyResolution;
  isExternal: boolean;
  importedSymbols: string[];
}

export interface IndexedFile {
  relativePath: string;
  canonicalPath: string;
  sizeBytes: number;
  mtimeMs: number;
  ctimeMs?: number;
  sha256: string;
  language: string;
  /** Number of lines (as split on "\n"), for source-token estimates without reading the file. */
  lineCount?: number;
  symbols: IndexedSymbol[];
  dependencies: IndexedDependency[];
  isTest: boolean;
  isConfig: boolean;
  isDoc: boolean;
}

export interface IndexChangeSet {
  added: string[];
  modified: string[];
  renamed: Array<{ from: string; to: string }>;
  deleted: string[];
  isStale?: boolean;
  /** Content-rejected files recorded in `ProjectIndex.skipped` by this build. */
  skippedCount?: number;
}

/** Why a file was inspected but intentionally not indexed. */
export type SkipReason = "sensitive_content" | "binary_content" | "unreadable";

/**
 * Safe stat-only memo of a skipped file: no content, no hash. A record is
 * honoured only while the file's size/mtime/ctime still match, so a changed
 * file is always reconsidered.
 */
export interface SkippedFileRecord {
  reason: SkipReason;
  sizeBytes: number;
  mtimeMs: number;
  ctimeMs?: number;
  /** When the record was made; only "unreadable" records use it, to expire. */
  recordedAtMs?: number;
}

/** Completeness of the last directory scan (never silently partial). */
export interface ScanSummary {
  complete: boolean;
  /** Entries were left unvisited because the file-count cap was reached. */
  fileLimitReached: boolean;
  fileLimit: number;
  /** Directories deeper than the traversal limit were not scanned. */
  depthLimitReached: boolean;
  /** Directories that could not be read. */
  unreadableDirs: number;
  skippedByReason: Partial<Record<SkipReason, number>>;
}

export interface ProjectIndex {
  meta: ProjectMeta;
  files: Record<string, IndexedFile>; // relativePath -> file
  symbolIndex: Record<string, IndexedSymbol[]>; // symbolName -> symbols
  rules: string[]; // Content of detected project rules (.cursorrules, AGENTS.md, etc.)
  totalTokensEstimated: number;
  generatedAt: string;
  changes?: IndexChangeSet;
  /** Files inspected but intentionally not indexed, keyed by relative path. Optional for legacy snapshots. */
  skipped?: Record<string, SkippedFileRecord>;
  /** Completeness of the scan that produced this snapshot. Optional for legacy snapshots. */
  scan?: ScanSummary;
  /** Symbol-extractor revision that produced `files[].symbols`; older snapshots are re-extracted. */
  extractorVersion?: number;
  /**
   * Shared snapshot identifier pairing this index file with `meta.json`
   * (see `ProjectMeta.snapshotId`). Optional for legacy snapshots, which
   * fall back to the timestamp-skew consistency check.
   */
  snapshotId?: string | null;
}

export interface SkillDefinition {
  id: string;
  version: string;
  name: string;
  description: string;
  relevantCategories: TaskCategory[];
  languages: string[];
  keywords: string[];
  content: string;
  trustClassification: "built-in" | "verified" | "untrusted";
  maxTokens: number;
}

export interface TokenMetrics {
  characterCount: number;
  byteCount: number;
  estimatedTokens: number;
  measuredTokens?: number; // Only populated if an exact tokenizer is executed
  isEstimate: boolean;
}

export interface ContextOmission {
  type: "file" | "symbol" | "skill" | "rule" | "dependency" | "secret";
  identifier: string;
  reason: "budget_exceeded" | "low_relevance" | "untrusted" | "stale" | "secret";
  estimatedTokens: number;
}

export interface ContextPackage {
  originalTask: string;
  classification: ClassificationResult;
  projectMeta: {
    id: string;
    name: string;
    canonicalPath: string;
    indexFreshness: "fresh" | "stale" | "unindexed";
    lastIndexedAt: string | null;
  };
  applicableRules: Array<{ source: string; content: string }>;
  sourceReferences: Array<{
    relativePath: string;
    startLine?: number;
    endLine?: number;
    relevanceScore: number;
    content: string;
  }>;
  symbols: IndexedSymbol[];
  dependencies: IndexedDependency[];
  selectedSkills: Array<{
    id: string;
    name: string;
    reason: string;
    content: string;
  }>;
  knownLimitations: string[];
  /** Bounded sample of what was left out; see `omissionsTotal` for the real count. */
  omissions: ContextOmission[];
  /** Total items omitted (>= omissions.length when the list was capped). */
  omissionsTotal?: number;
  /**
   * How many entries of `omissions` the rendered prompt lists. It shrinks under
   * budget pressure (the list is diagnostic, so it goes before any source,
   * skill or rule does); the structured list itself is unchanged.
   */
  omissionRenderLimit?: number;
  /**
   * The budget this package was assembled under and where it came from. It
   * bounds this package only, not the model's full input.
   */
  budget?: { tokens: number; origin: "explicit" | "task-default" | "default" };
  tokenMetrics: TokenMetrics;
  assembledAt: string;
}

/** Drift result a caller already computed for this request, so it is not re-scanned. */
export interface KnownStaleness {
  isStale: boolean;
  staleFiles: string[];
  deletedFiles: string[];
}

export interface RetrievalOptions {
  task: string;
  categoryOverride?: TaskCategory;
  tokenBudget?: number; // Default 4000, or the task default when `adaptiveBudget` is set
  /**
   * With no explicit `tokenBudget`, start from the task category's budget and
   * stop adding files once their relevance falls far below the best match
   * (reported as `low_relevance` omissions). An explicit `tokenBudget` always
   * wins and keeps the exhaustive behaviour.
   */
  adaptiveBudget?: boolean;
  fileBudget?: number; // Default 10
  includeSkills?: boolean;
  includeTests?: boolean;
  format?: "text" | "json";
  assembledAt?: string;
  tokenizer?: (text: string) => number;
  /**
   * Ceiling for the rendered prompt in JSON-escaped UTF-8 bytes (the size it
   * takes inside an MCP text result). Optional sources are dropped to fit.
   */
  maxBytes?: number;
  /** Skip the drift re-scan when the caller's freshness gate already ran. */
  knownStaleness?: KnownStaleness;
}

export interface EvaluationBaseline {
  taskDescription: string;
  category: TaskCategory;
  config: "A_baseline_no_kai" | "B_kai_basic" | "C_kai_templates_skills" | "D_kai_optimized";
  contextTokenEstimate: number;
  retrievalLatencyMs: number;
  toolCallsCount: number;
  retrievedFilesCount: number;
  omissionsCount: number;
  taskSuccessRate: number; // 0.0 - 1.0
  notes: string;
}
