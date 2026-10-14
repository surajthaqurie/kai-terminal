import React, { useEffect, useRef, useState } from 'react';

export function HeroTerminal({ version }: { version: string }) {
  const [terminalInput, setTerminalInput] = useState('');
  const viewRef = useRef<HTMLDivElement | null>(null);
  const [terminalHistory, setTerminalHistory] = useState<
    Array<{ cmd: string; output: React.ReactNode }>
  >([
    {
      cmd: 'kai status',
      output: (
        <div style={{ color: '#34d399' }}>
          <p>✔ Kai {version} is ready</p>
          <p>✔ Fast and private · Free</p>
        </div>
      ),
    },
  ]);

  const run = (rawInput: string) => {
    const input = rawInput.trim().toLowerCase();
    if (!input) return;
    let reply: React.ReactNode = '';
    if (['help', '?', 'kai --help', 'kai -h'].includes(input)) {
      reply = (
        <div style={{ color: '#67e8f9' }}>
          <p>try: <b style={{ color: '#fcd34d' }}>status</b> · <b style={{ color: '#fcd34d' }}>list</b> · <b style={{ color: '#fcd34d' }}>claude</b> · <b style={{ color: '#fcd34d' }}>graph</b> · <b style={{ color: '#fcd34d' }}>doctor</b> · <b style={{ color: '#fcd34d' }}>lsp</b> · <b style={{ color: '#fcd34d' }}>downloads</b> · <b style={{ color: '#fcd34d' }}>clear</b></p>
        </div>
      );
    } else if (['status', 'kai --status', 'kai status'].includes(input)) {
      reply = (
        <div style={{ color: '#34d399' }}>
          <p>✔ Project: web-app (id: e2b57f01a8cd3241)</p>
          <p>✔ Files: 142 · Symbols: 890 · Freshness: fresh</p>
          <p>✔ Semantic Mode: active (LSP connected) · Commit Hook: installed</p>
        </div>
      );
    } else if (['list', 'kai list', 'kai list -a'].includes(input)) {
      reply = (
        <div style={{ color: '#d8b4fe' }}>
          <p>[kai] AI Agent Detection (live system probe):</p>
          <p>  <span style={{ color: '#34d399' }}>✓</span> claude     Claude Code      · kai wired <span style={{ color: '#34d399' }}>✓</span></p>
          <p>  <span style={{ color: '#34d399' }}>✓</span> cursor     Cursor           · kai wired <span style={{ color: '#34d399' }}>✓</span></p>
          <p>  <span style={{ color: '#34d399' }}>✓</span> aider      Aider            · kai wired <span style={{ color: '#34d399' }}>✓</span></p>
          <p>  <span style={{ color: '#34d399' }}>✓</span> gemini     Gemini CLI       · kai wired <span style={{ color: '#34d399' }}>✓</span></p>
          <p>  <span style={{ color: '#34d399' }}>✓</span> opencode   opencode         · kai wired <span style={{ color: '#34d399' }}>✓</span></p>
        </div>
      );
    } else if (['claude', 'kai claude', 'kai claude .', 'kai cursor', 'kai aider'].includes(input)) {
      reply = (
        <div style={{ color: '#38bdf8' }}>
          <p>[kai] MCP auto-wired for claude · Entering Code Mode</p>
          <p>[kai] AST graph synchronized: incremental (3 modified files in 24ms)</p>
          <p style={{ color: '#34d399' }}>[kai] commit-msg hook active: auto-strip AI co-authors</p>
        </div>
      );
    } else if (['graph', 'kai graph', 'kai graph status'].includes(input)) {
      reply = (
        <div style={{ color: '#34d399' }}>
          <p>[kai] Graph Status for "web-app":</p>
          <p>  Files: 142 · Symbols: 890 · AST Engine: ready</p>
          <p style={{ color: '#94a3b8', fontSize: '0.75rem' }}>Auto-syncs incremental file changes on agent exit</p>
        </div>
      );
    } else if (['doctor', 'kai doctor'].includes(input)) {
      reply = (
        <div style={{ color: '#67e8f9' }}>
          <p>[kai] Doctor — install & desktop diagnostics (kai {version}):</p>
          <p>  Platform: linux/x64 · Binary: /usr/bin/kai <span style={{ color: '#34d399' }}>✓</span></p>
          <p>  Renderer: WebGL GPU (60fps) <span style={{ color: '#34d399' }}>✓</span> · KAI_HOME: ~/.kai <span style={{ color: '#34d399' }}>✓</span></p>
        </div>
      );
    } else if (['lsp', 'kai lsp'].includes(input)) {
      reply = (
        <div style={{ color: '#38bdf8' }}>
          <p>[kai] Language Server Protocol (LSP) Bridge Status:</p>
          <p>  <span style={{ color: '#34d399' }}>✓</span> typescript (typescript-language-server)</p>
          <p>  <span style={{ color: '#34d399' }}>✓</span> python (pyright) · <span style={{ color: '#34d399' }}>✓</span> rust (rust-analyzer)</p>
        </div>
      );
    } else if (['downloads', 'download', 'install'].includes(input)) {
      reply = (
        <div style={{ color: '#67e8f9' }}>
          <p>.dmg (macOS) · .deb / .AppImage (Linux) · .exe / .msi (Windows)</p>
          <p style={{ color: '#94a3b8' }}>Visit the /download page to pick your installer</p>
        </div>
      );
    } else if (['version', 'kai --version'].includes(input)) {
      reply = <p style={{ color: '#67e8f9' }}>Kai {version} — MIT licensed, Tauri 2 + Rust</p>;
    } else if (['ls', 'dir'].includes(input)) {
      reply = <p style={{ color: '#94a3b8' }}>src/ src-tauri/ packaging/ Cargo.toml package.json</p>;
    } else if (input === 'clear' || input === 'cls') {
      setTerminalHistory([]);
      setTerminalInput('');
      return;
    } else {
      reply = <p style={{ color: '#fb7185' }}>not found: '{rawInput}'. type 'help'.</p>;
    }
    setTerminalHistory((prev) => [...prev, { cmd: rawInput, output: reply }]);
    setTerminalInput('');
  };

  useEffect(() => {
    const el = viewRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [terminalHistory]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    run(terminalInput);
  };

  const chips = ['kai status', 'kai list -a', 'kai claude', 'kai graph status', 'help'];

  return (
    <div className="t-terminal" role="region" aria-label="Interactive Kai preview terminal">
      <div className="t-terminal-bar">
        <div className="t-terminal-dots">
          <span className="t-dot" style={{ backgroundColor: '#ef4444' }}></span>
          <span className="t-dot" style={{ backgroundColor: '#f59e0b' }}></span>
          <span className="t-dot" style={{ backgroundColor: '#10b981' }}></span>
          <span className="t-terminal-title">kai — zsh</span>
        </div>
        <div className="t-terminal-chips" role="group" aria-label="Try these commands">
          {chips.map((c) => (
            <button key={c} type="button" onClick={() => run(c)} className="t-chip" title={`Run ${c}`}>
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="t-terminal-view" ref={viewRef}>
        {terminalHistory.map((item, idx) => (
          <div key={idx} className="t-term-line">
            <div className="t-term-prompt">
              <span>➜ ~</span>
              <span className="t-term-cmd">{item.cmd}</span>
            </div>
            <div className="t-term-out">{item.output}</div>
          </div>
        ))}
        <form onSubmit={onSubmit} className="t-term-form">
          <span style={{ color: '#38bdf8' }}>➜ ~</span>
          <input
            type="text"
            value={terminalInput}
            onChange={(e) => setTerminalInput(e.target.value)}
            placeholder="type 'help' + enter — it's live"
            className="t-term-input"
            aria-label="Preview terminal input"
          />
        </form>
      </div>
    </div>
  );
}
