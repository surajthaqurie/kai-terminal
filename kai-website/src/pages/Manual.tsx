import { useState, useMemo } from 'react';
import {
  BookOpen,
  Search,
  Info,
  AlertTriangle,
  X,
} from 'lucide-react';
import { PageHero } from '../components/PageHero';
import { Container, Badge } from '../components/ui';
import { CopyBtn } from '../components/CopyBtn';
import { CtaBanner } from '../components/CtaBanner';

type ManualSection = {
  id: string;
  title: string;
  tag: string;
  keywords: string[];
};

const SECTIONS: ManualSection[] = [
  { id: 'boundary', title: '1. Architectural Boundaries', tag: 'Architecture', keywords: ['boundary', 'shell', 'external', 'internal', 'kai_terminal', 'environment'] },
  { id: 'external', title: '2. External Commands', tag: 'External', keywords: ['open', 'close', 'help', 'version', 'kai open', 'kai close'] },
  { id: 'agent-exec', title: '3. Running AI Agents', tag: 'Agent Workflow', keywords: ['claude', 'cursor', 'codex', 'gemini', 'opencode', 'aider', 'windsurf', 'cline', 'agy', 'auto-sync', 'co-author', 'hooks'] },
  { id: 'resource-list', title: '4. Resource Listing', tag: 'Inspect', keywords: ['list', 'agents', 'indexes', 'sessions', 'config', 'kai list', '-a', '-i', '-s', '-c'] },
  { id: 'agent-setup', title: '5. Agent MCP Setup', tag: 'Configuration', keywords: ['setup', 'mcp', 'auto-wire', 'dry-run', 'print', 'force', 'project', 'kai setup'] },
  { id: 'resource-remove', title: '6. Resource Removal', tag: 'Safe Deletion', keywords: ['remove', 'delete', 'safe', 'uninstall', 'kai remove', '-i', '-a', '-s'] },
  { id: 'graph', title: '7. Project Dependency Graph', tag: 'AST Engine', keywords: ['graph', 'init', 'update', 'status', 'ast', 'symbols', 'tree-sitter'] },
  { id: 'diagnostics', title: '8. Status, Doctor & LSP', tag: 'Diagnostics', keywords: ['status', 'doctor', 'lsp', 'stop', 'metrics', 'diagnostics', 'language server'] },
  { id: 'cheatsheet', title: '9. Quick Reference Cheatsheet', tag: 'Cheatsheet', keywords: ['cheatsheet', 'table', 'summary', 'reference', 'all commands'] },
];

const CHEATSHEET_ROWS = [
  { cmd: 'kai open [path]', env: 'External Shell', desc: 'Opens or focuses Kai Terminal desktop application for a project directory.' },
  { cmd: 'kai close', env: 'External Shell', desc: 'Closes running Kai Terminal desktop application instances.' },
  { cmd: 'kai --help / --version', env: 'Any Shell', desc: 'Displays Kai CLI version or top-level manual documentation.' },
  { cmd: 'kai <agent> [path]', env: 'Kai Terminal', desc: 'Launches AI agent with auto MCP wiring, Code Mode, and graph auto-sync.' },
  { cmd: 'kai list -a', env: 'Kai Terminal', desc: 'Lists installed AI coding agents and their Kai MCP wiring status.' },
  { cmd: 'kai list -i', env: 'Kai Terminal', desc: 'Lists registered project indexes, health, freshness, and symbol counts.' },
  { cmd: 'kai list -s', env: 'Kai Terminal', desc: 'Lists managed session files and AST cache binaries.' },
  { cmd: 'kai list -c', env: 'Kai Terminal', desc: 'Displays active CLI configuration parameters and token budgets.' },
  { cmd: 'kai setup <agent|all>', env: 'Kai Terminal', desc: 'Auto-wires Kai MCP server directly into agent configurations with backup.' },
  { cmd: 'kai remove -i <path|id>', env: 'Kai Terminal', desc: 'Deletes project index from ~/.kai/projects/ (repo files are NEVER touched).' },
  { cmd: 'kai remove -a <name>', env: 'Kai Terminal', desc: 'Removes Kai MCP configuration entry from the specified agent.' },
  { cmd: 'kai remove -s [target]', env: 'Kai Terminal', desc: 'Deletes session cache files and active state.' },
  { cmd: 'kai graph init [path]', env: 'Kai Terminal', desc: 'Builds full baseline AST symbol index and dependency graph.' },
  { cmd: 'kai graph update [path]', env: 'Kai Terminal', desc: 'Forces full re-indexing and update of the AST project graph.' },
  { cmd: 'kai graph status [path]', env: 'Kai Terminal', desc: 'Displays graph index metrics, indexed file counts, and symbols.' },
  { cmd: 'kai status [path]', env: 'Kai Terminal', desc: 'Shows project health, freshness, commit-msg hook, and LSP status.' },
  { cmd: 'kai stop', env: 'Kai Terminal', desc: 'Clears active Code Mode state and returns to standard terminal mode.' },
  { cmd: 'kai doctor', env: 'Kai Terminal', desc: 'Audits local environment, desktop binary path, and .desktop entry.' },
  { cmd: 'kai lsp', env: 'Kai Terminal', desc: 'Probes local Language Server Protocol servers (TS, Python, Rust, Go).' },
  { cmd: 'kai metrics [clear]', env: 'Kai Terminal', desc: 'Displays or clears local privacy-safe operation telemetry and latencies.' },
];

export function ManualPage() {
  const [query, setQuery] = useState('');

  const filteredSections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTIONS;
    return SECTIONS.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.tag.toLowerCase().includes(q) ||
        s.keywords.some((k) => k.includes(q))
    );
  }, [query]);

  const filteredCheatsheet = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return CHEATSHEET_ROWS;
    return CHEATSHEET_ROWS.filter(
      (r) =>
        r.cmd.toLowerCase().includes(q) ||
        r.env.toLowerCase().includes(q) ||
        r.desc.toLowerCase().includes(q)
    );
  }, [query]);

  return (
    <>
      <PageHero
        badge={<><BookOpen size={14} /> Documentation</>}
        title="User Manual & Reference"
        sub="Comprehensive architecture boundaries, internal & external CLI commands, AI agent execution models, and quick reference cheatsheet."
      />

      {/* Sticky Table of Contents Navigation */}
      <div className="t-container">
        <nav className="t-manual-nav" aria-label="Manual Sections">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`} className="t-manual-nav-pill">
              {s.tag}
            </a>
          ))}
        </nav>

        {/* Live Search Bar */}
        <div className="t-manual-search-wrap">
          <Search size={18} className="t-manual-search-icon" />
          <input
            type="text"
            className="t-manual-search-input"
            placeholder="Search commands, flags, agents, or topics (e.g., 'mcp', 'open', 'doctor', 'claude')..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter user manual"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              style={{
                position: 'absolute',
                right: '1rem',
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'none',
                border: 'none',
                color: 'var(--text-tertiary)',
                cursor: 'pointer',
              }}
              title="Clear search"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      <section className="t-section" style={{ paddingTop: '0.5rem' }}>
        <Container narrow>
          {/* Section 1: Architectural Boundaries */}
          {(query === '' || filteredSections.some((s) => s.id === 'boundary')) && (
            <div id="boundary" className="t-manual-card">
              <div className="t-manual-card-header">
                <div>
                  <Badge tone="cyan">Architecture</Badge>
                  <h2 style={{ fontSize: '1.4rem', fontWeight: 800 }}>1. Architectural Boundaries & Execution Model</h2>
                </div>
              </div>
              <p style={{ color: 'var(--text-secondary)', lineHeight: 1.65, marginBottom: '1.25rem' }}>
                Kai CLI enforces a strict environment boundary between your external host shell (Bash, Zsh, PowerShell) and the managed environment inside Kai Terminal. This prevents accidental index corruption, protects running workflows, and guarantees deterministic agent lifecycle tracking.
              </p>

              <div className="t-manual-output" style={{ fontSize: '0.78rem', lineHeight: 1.5 }}>
{`┌─────────────────────────────────────────────────────────────────────────────┐
│                       EXTERNAL SHELL (Bash / Zsh / PowerShell)              │
│                                                                             │
│   • kai open [path]        Opens or focuses Kai Terminal for a project      │
│   • kai close              Closes running Kai Terminal instances            │
│   • kai --help / --version Display help and version information             │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                kai open [path]
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      INSIDE KAI TERMINAL (KAI_TERMINAL=1)                   │
│                                                                             │
│   • kai <agent> [path]     Launch AI agents (auto MCP, Code Mode, sync)     │
│   • kai list [-a|-i|-s|-c] Inspect agents, indexed projects, sessions       │
│   • kai setup <agent|all>  Auto-wire Kai MCP into agent configs             │
│   • kai remove [-i|-a|-s]  Safely remove index, agent MCP, or sessions      │
│   • kai graph <subcommand> Manage AST symbol index & dependency graph       │
│   • kai status [path]      Show project metadata, LSP, and hook health      │
│   • kai stop               Exit Code Mode back to plain terminal            │
│   • kai doctor / lsp       Diagnostics and Language Server bridge status    │
└─────────────────────────────────────────────────────────────────────────────┘`}
              </div>

              <div className="t-callout-tip">
                <Info size={18} />
                <div>
                  <strong>Clean Boundary Exit Handling:</strong> If an agent or internal command is accidentally invoked from an external terminal, Kai exits cleanly with helpful instructions:
                  <div style={{ marginTop: '0.5rem', fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                    [kai] Error: 'kai claude' can only be executed inside Kai Terminal.<br />
                    To open or focus Kai Terminal for your project, run: <code>kai open [path]</code>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Section 2: External Commands */}
          {(query === '' || filteredSections.some((s) => s.id === 'external')) && (
            <div id="external" className="t-manual-card">
              <div className="t-manual-card-header">
                <div>
                  <Badge tone="neutral">Host System</Badge>
                  <h2 style={{ fontSize: '1.4rem', fontWeight: 800 }}>2. External Commands (Any Shell)</h2>
                </div>
              </div>
              <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
                These commands are intended to be executed from any standard terminal on macOS, Linux, or Windows.
              </p>

              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: '1.25rem 0 0.5rem' }}><code>kai open [path]</code></h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.92rem' }}>
                Opens or focuses the Kai Terminal desktop application for the specified project directory (defaults to current directory <code>.</code>). Automatically primes Code Mode and registers the project root.
              </p>
              <div className="t-panel" style={{ padding: '0.85rem 1.25rem', margin: '0.75rem 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <code style={{ fontSize: '0.85rem', color: 'var(--accent-cyan-fg)' }}>kai open /path/to/project</code>
                  <CopyBtn text="kai open ." />
                </div>
              </div>
              <div className="t-manual-output">
{`[kai] Opened Kai Terminal for "my-project" (/home/kali/Documents/my-project)`}
              </div>

              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: '1.75rem 0 0.5rem' }}><code>kai close</code></h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.92rem' }}>
                Gracefully closes active Kai Terminal desktop application instances across macOS, Linux, and Windows.
              </p>
              <div className="t-panel" style={{ padding: '0.85rem 1.25rem', margin: '0.75rem 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <code style={{ fontSize: '0.85rem', color: 'var(--accent-cyan-fg)' }}>kai close</code>
                  <CopyBtn text="kai close" />
                </div>
              </div>
            </div>
          )}

          {/* Section 3: Running AI Agents */}
          {(query === '' || filteredSections.some((s) => s.id === 'agent-exec')) && (
            <div id="agent-exec" className="t-manual-card">
              <div className="t-manual-card-header">
                <div>
                  <Badge tone="purple">Workflow</Badge>
                  <h2 style={{ fontSize: '1.4rem', fontWeight: 800 }}>3. Running AI Coding Agents (Inside Kai)</h2>
                </div>
              </div>
              <p style={{ color: 'var(--text-secondary)', lineHeight: 1.65, marginBottom: '1rem' }}>
                Running <code>kai &lt;agent&gt; [path]</code> inside Kai Terminal launches your chosen AI coding tool with end-to-end orchestration:
              </p>
              <ol className="t-beginner-list" style={{ marginBottom: '1.25rem' }}>
                <li>Registers target project path and activates Code Mode.</li>
                <li>Auto-wires Kai's Model Context Protocol (MCP) server directly into the agent's configuration.</li>
                <li>Ensures the Tree-sitter AST symbol index and dependency graph are built.</li>
                <li>Installs a lightweight, POSIX-compliant <code>commit-msg</code> git hook that automatically strips AI co-author trailers while keeping your existing hooks intact.</li>
                <li>Launches the agent process directly in your terminal pane.</li>
                <li><strong>Automatic Graph Sync:</strong> Incremental re-indexing of modified files triggers automatically when the agent exits.</li>
              </ol>

              <div className="t-panel" style={{ padding: '0.85rem 1.25rem', margin: '0.75rem 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <code style={{ fontSize: '0.88rem', color: 'var(--accent-cyan-fg)' }}>kai claude [path]</code>
                  <CopyBtn text="kai claude ." />
                </div>
              </div>

              <p style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', marginTop: '0.75rem' }}>
                <strong>Supported Agents:</strong> <code>claude</code>, <code>cursor</code>, <code>codex</code>, <code>gemini</code>, <code>opencode</code>, <code>aider</code>, <code>windsurf</code>, <code>cline</code>, <code>copilot</code>, <code>agy</code>.
              </p>

              <div className="t-manual-output">
{`[kai] MCP configuration auto-wired for claude.
[kai] Indexing project for Code Mode run...
[kai] Running Code Mode task in "my-project": claude
... [Agent Session Runs Here] ...
[kai] Agent finished (command exited with code 0, 1842ms).
[kai] Graph auto-sync: incremental (changed-files; freshness: fresh). Re-indexed 3 modified files in 24ms.`}
              </div>
            </div>
          )}

          {/* Section 4: Resource Listing */}
          {(query === '' || filteredSections.some((s) => s.id === 'resource-list')) && (
            <div id="resource-list" className="t-manual-card">
              <div className="t-manual-card-header">
                <div>
                  <Badge tone="cyan">Inspection</Badge>
                  <h2 style={{ fontSize: '1.4rem', fontWeight: 800 }}>4. Resource Listing (`kai list [flags]`)</h2>
                </div>
              </div>
              <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
                Inspect detected agents, registered project indexes, active session files, or active configuration.
              </p>

              <div className="t-manual-table-wrap">
                <table className="t-manual-table">
                  <thead>
                    <tr>
                      <th>Flag</th>
                      <th>Target</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td><code>-a, --agent</code></td>
                      <td>AI Agents</td>
                      <td>Live system probe of installed AI agents and Kai MCP auto-wiring state (default behavior).</td>
                    </tr>
                    <tr>
                      <td><code>-i, --index</code></td>
                      <td>Project Indexes</td>
                      <td>Lists all registered project directories, symbol metrics, and freshness timestamps.</td>
                    </tr>
                    <tr>
                      <td><code>-s, --session</code></td>
                      <td>Sessions & Cache</td>
                      <td>Lists managed session and AST token cache files in ~/.kai/.</td>
                    </tr>
                    <tr>
                      <td><code>-c, --config</code></td>
                      <td>Configuration</td>
                      <td>Displays active CLI settings, token limits, and indexing depth.</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="t-manual-output">
{`$ kai list -a
[kai] AI Agent Detection (live system probe):
  ✓ claude     Claude Code      Installed (/usr/local/bin/claude), configured · kai wired ✓
  ✓ cursor     Cursor           Installed (/usr/bin/cursor), configured · kai wired ✓
  ✓ opencode   opencode         Installed (/usr/bin/opencode) · kai wired ✓
  ✓ aider      Aider            Installed (~/.local/bin/aider) · kai wired ✓
  ✓ gemini     Gemini CLI       Installed (~/.local/bin/gemini) · kai wired ✓
  ✓ agy        Antigravity CLI  Installed (/usr/local/bin/agy) · kai wired ✓`}
              </div>
            </div>
          )}

          {/* Section 5: Agent MCP Setup */}
          {(query === '' || filteredSections.some((s) => s.id === 'agent-setup')) && (
            <div id="agent-setup" className="t-manual-card">
              <div className="t-manual-card-header">
                <div>
                  <Badge tone="purple">Wiring</Badge>
                  <h2 style={{ fontSize: '1.4rem', fontWeight: 800 }}>5. Agent MCP Setup (`kai setup &lt;agent|all&gt;`)</h2>
                </div>
              </div>
              <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '1rem' }}>
                Auto-wires Kai's Model Context Protocol (MCP) server directly into the target agent's native configuration file. Previous configuration files are automatically backed up with <code>.kai.bak</code> before any edits are made.
              </p>

              <div className="t-panel" style={{ padding: '0.85rem 1.25rem', margin: '0.75rem 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <code style={{ fontSize: '0.88rem', color: 'var(--accent-cyan-fg)' }}>kai setup all</code>
                  <CopyBtn text="kai setup all" />
                </div>
              </div>

              <div className="t-manual-table-wrap">
                <table className="t-manual-table">
                  <thead>
                    <tr>
                      <th>Option</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td><code>--print</code></td>
                      <td>Prints the MCP JSON snippet to stdout without modifying files on disk.</td>
                    </tr>
                    <tr>
                      <td><code>--dry-run</code></td>
                      <td>Previews configuration file targets and planned changes without writing.</td>
                    </tr>
                    <tr>
                      <td><code>--force</code></td>
                      <td>Overwrites existing Kai MCP configuration entries.</td>
                    </tr>
                    <tr>
                      <td><code>--project</code></td>
                      <td>Writes MCP configuration to project-local settings rather than global user directory.</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="t-manual-output">
{`$ kai setup claude
[kai] Auto-wired kai MCP entry in ~/.claude.json.
[kai] Previous config backed up to: ~/.claude.json.kai.bak
[kai] Restart Claude Code so it picks up the kai MCP server.`}
              </div>
            </div>
          )}

          {/* Section 6: Resource Removal */}
          {(query === '' || filteredSections.some((s) => s.id === 'resource-remove')) && (
            <div id="resource-remove" className="t-manual-card">
              <div className="t-manual-card-header">
                <div>
                  <Badge tone="neutral">Safe Clean</Badge>
                  <h2 style={{ fontSize: '1.4rem', fontWeight: 800 }}>6. Safe Resource Removal (`kai remove [flags]`)</h2>
                </div>
              </div>
              <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '1rem' }}>
                Safely removes Kai-owned index directories, agent MCP wiring, or session cache files.
              </p>

              <div className="t-callout-warn">
                <AlertTriangle size={18} />
                <div>
                  <strong>Repository Safety Guarantee:</strong> Kai only deletes data inside <code>~/.kai/</code>. Your source code, git history, and repository files are <strong>NEVER modified or deleted</strong>.
                </div>
              </div>

              <div className="t-manual-table-wrap">
                <table className="t-manual-table">
                  <thead>
                    <tr>
                      <th>Flag</th>
                      <th>Target</th>
                      <th>Example</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td><code>-i, --index &lt;path|id&gt;</code></td>
                      <td>Project AST Index</td>
                      <td><code>kai remove -i .</code> (or by 16-hex hash ID)</td>
                    </tr>
                    <tr>
                      <td><code>-a, --agent &lt;name&gt;</code></td>
                      <td>Agent MCP Configuration</td>
                      <td><code>kai remove -a claude</code></td>
                    </tr>
                    <tr>
                      <td><code>-s, --session [target]</code></td>
                      <td>Session & Cache Files</td>
                      <td><code>kai remove -s</code></td>
                    </tr>
                    <tr>
                      <td><code>--dry-run</code></td>
                      <td>Preview Action</td>
                      <td><code>kai remove -i . --dry-run</code></td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="t-manual-output">
{`$ kai remove -i .
[kai] Remove Project Index Scope:
  Project:           "my-project" (id: e2b57f01a8cd3241)
  Index data:        /home/kali/.kai/projects/e2b57f01a8cd3241
  NOTE: Only Kai-owned data under ~/.kai/projects/ is removed.
  NOTE: The repository at /home/kali/Documents/my-project is NOT touched.
[kai] Project "my-project" index deleted.`}
              </div>
            </div>
          )}

          {/* Section 7: Dependency Graph */}
          {(query === '' || filteredSections.some((s) => s.id === 'graph')) && (
            <div id="graph" className="t-manual-card">
              <div className="t-manual-card-header">
                <div>
                  <Badge tone="cyan">Tree-sitter</Badge>
                  <h2 style={{ fontSize: '1.4rem', fontWeight: 800 }}>7. Project Dependency Graph (`kai graph`)</h2>
                </div>
              </div>
              <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
                Manage the AST symbol database, dependency graph, and project rules manually if needed.
              </p>

              <div className="t-manual-table-wrap">
                <table className="t-manual-table">
                  <thead>
                    <tr>
                      <th>Subcommand</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td><code>kai graph init [path]</code></td>
                      <td>Builds baseline Tree-sitter symbol index and dependency graph for the project directory.</td>
                    </tr>
                    <tr>
                      <td><code>kai graph update [path]</code></td>
                      <td>Forces an immediate full re-parse and update of the AST database.</td>
                    </tr>
                    <tr>
                      <td><code>kai graph status [path]</code></td>
                      <td>Displays graph status, indexed file counts, symbol totals, and last update timestamp.</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="t-manual-output">
{`$ kai graph init .
[kai] Initializing graph for "my-project"...
[kai] Index ready!
- Files indexed: 142
- Symbols indexed: 890
- Project rules loaded: 3
- Incremental changes: +142 added, ~0 modified, ->0 renamed, -0 deleted`}
              </div>
            </div>
          )}

          {/* Section 8: Status, Doctor & LSP */}
          {(query === '' || filteredSections.some((s) => s.id === 'diagnostics')) && (
            <div id="diagnostics" className="t-manual-card">
              <div className="t-manual-card-header">
                <div>
                  <Badge tone="neutral">Health & Diagnostics</Badge>
                  <h2 style={{ fontSize: '1.4rem', fontWeight: 800 }}>8. Status, Doctor & LSP Diagnostics</h2>
                </div>
              </div>

              <h3 style={{ fontSize: '1.05rem', fontWeight: 700, margin: '1rem 0 0.4rem' }}><code>kai status [path]</code></h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                Shows project registration metadata, index freshness, Language Server Protocol (LSP) semantic mode, and commit hook status.
              </p>
              <div className="t-manual-output">
{`[kai] Project Status:
  Name:             my-project
  ID:               e2b57f01a8cd3241
  Root:             /home/kali/Documents/my-project
  Status:           ready (fresh)
  Files Indexed:    142 · Symbols: 890
  Commit Hook:      installed (auto-strip AI co-authors)
  Semantic Mode:    active (LSP connected)`}
              </div>

              <h3 style={{ fontSize: '1.05rem', fontWeight: 700, margin: '1.5rem 0 0.4rem' }}><code>kai doctor</code></h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                Audits your local environment, user PATH, desktop binary location, storage directories, and Linux desktop drawer (.desktop) integration.
              </p>
              <div className="t-manual-output">
{`[kai] Doctor — environment & install diagnostics (kai v0.1.4)
  Platform:          linux/x64 (node v20.18.0)
  KAI_HOME:          /home/kali/.kai
  Desktop app binary: /usr/bin/kai ✓
  Linux app-drawer entries: 1 (/usr/share/applications/kai.desktop ✓)`}
              </div>

              <h3 style={{ fontSize: '1.05rem', fontWeight: 700, margin: '1.5rem 0 0.4rem' }}><code>kai lsp</code></h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                Probes local Language Server Protocol (LSP) servers installed on your PATH.
              </p>
              <div className="t-manual-output">
{`[kai] Language Server Protocol (LSP) Bridge Status:
  ✓ typescript   typescript-language-server   Available (installed)
  ✓ python       pyright                      Available (installed)
  ✓ rust         rust-analyzer                Available (installed)
  ✗ golang       gopls                        Not Found (go install golang.org/x/tools/gopls@latest)`}
              </div>

              <h3 style={{ fontSize: '1.05rem', fontWeight: 700, margin: '1.5rem 0 0.4rem' }}><code>kai stop</code></h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                Clears active Code Mode state and returns Kai Terminal to standard shell mode without deleting indexes.
              </p>
            </div>
          )}

          {/* Section 9: Cheatsheet */}
          {(query === '' || filteredSections.some((s) => s.id === 'cheatsheet')) && (
            <div id="cheatsheet" className="t-manual-card">
              <div className="t-manual-card-header">
                <div>
                  <Badge tone="cyan">Reference</Badge>
                  <h2 style={{ fontSize: '1.4rem', fontWeight: 800 }}>9. Quick Reference Cheatsheet</h2>
                </div>
              </div>

              <div className="t-manual-table-wrap">
                <table className="t-manual-table">
                  <thead>
                    <tr>
                      <th>Command</th>
                      <th>Environment</th>
                      <th>Description</th>
                      <th style={{ textAlign: 'right' }}>Copy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCheatsheet.map((row) => (
                      <tr key={row.cmd}>
                        <td>
                          <code style={{ fontSize: '0.8rem', color: 'var(--accent-cyan-fg)', fontWeight: 700 }}>
                            {row.cmd}
                          </code>
                        </td>
                        <td>
                          <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                            {row.env}
                          </span>
                        </td>
                        <td style={{ fontSize: '0.85rem' }}>{row.desc}</td>
                        <td style={{ textAlign: 'right' }}>
                          <CopyBtn text={row.cmd.split(' ')[0] + ' ' + (row.cmd.split(' ')[1] || '')} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Container>
      </section>

      <CtaBanner />
    </>
  );
}
