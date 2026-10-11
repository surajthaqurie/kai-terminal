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
}

export interface SymbolLocation {
  filePath: string;
  line: number;
  column: number;
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
}

export interface IndexedDependency {
  sourceFile: string;
  targetSpecifier: string;
  resolvedPath?: string | null;
  isExternal: boolean;
  importedSymbols: string[];
}

export interface IndexedFile {
  relativePath: string;
  canonicalPath: string;
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
  language: string;
  symbols: IndexedSymbol[];
  dependencies: IndexedDependency[];
  isTest: boolean;
  isConfig: boolean;
  isDoc: boolean;
}

export interface ProjectIndex {
  meta: ProjectMeta;
  files: Record<string, IndexedFile>; // relativePath -> file
  symbolIndex: Record<string, IndexedSymbol[]>; // symbolName -> symbols
  rules: string[]; // Content of detected project rules (.cursorrules, AGENTS.md, etc.)
  totalTokensEstimated: number;
  generatedAt: string;
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
  type: "file" | "symbol" | "skill" | "rule" | "dependency";
  identifier: string;
  reason: "budget_exceeded" | "low_relevance" | "untrusted" | "stale";
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
  omissions: ContextOmission[];
  tokenMetrics: TokenMetrics;
  assembledAt: string;
}

export interface RetrievalOptions {
  task: string;
  categoryOverride?: TaskCategory;
  tokenBudget?: number; // Default 4000
  fileBudget?: number; // Default 10
  includeSkills?: boolean;
  includeTests?: boolean;
  format?: "text" | "json";
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
