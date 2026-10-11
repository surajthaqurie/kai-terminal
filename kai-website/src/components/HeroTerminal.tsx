import React, { useEffect, useRef, useState } from 'react';

export function HeroTerminal({ version }: { version: string }) {
  const [terminalInput, setTerminalInput] = useState('');
  const viewRef = useRef<HTMLDivElement | null>(null);
  const [terminalHistory, setTerminalHistory] = useState<
    Array<{ cmd: string; output: React.ReactNode }>
  >([
    {
      cmd: 'kai --status',
      output: (
        <div style={{ color: '#34d399' }}>
          <p>✔ engine {version} · portable-pty 0.8 · xterm.js 60fps</p>
          <p>✔ tabs isolated · zero telemetry · MIT</p>
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
          <p>try: <b style={{ color: '#fcd34d' }}>status</b> · <b style={{ color: '#fcd34d' }}>mcp</b> · <b style={{ color: '#fcd34d' }}>query</b> · <b style={{ color: '#fcd34d' }}>downloads</b> · <b style={{ color: '#fcd34d' }}>clear</b></p>
        </div>
      );
    } else if (['status', 'kai --status', 'kai status'].includes(input)) {
      reply = (
        <div style={{ color: '#34d399' }}>
          <p>✔ engine operational · ConPTY / POSIX pty</p>
          <p>✔ render: xterm.js canvas @ 60fps · ~30MB idle</p>
          <p>✔ project intelligence: schema v1 · 7 MCP tools available</p>
        </div>
      );
    } else if (['mcp', 'kai mcp', 'kai mcp .'].includes(input)) {
      reply = (
        <div style={{ color: '#34d399' }}>
          <p>[kai-mcp] stdio JSON-RPC server listening</p>
          <p style={{ color: '#a78bfa' }}>tools: kai_project_info · kai_search_code · kai_find_symbol · kai_get_context</p>
          <p style={{ color: '#94a3b8', fontSize: '0.75rem' }}>latency &lt; 10ms · read-only workspace boundary enforced</p>
        </div>
      );
    } else if (input.startsWith('kai query') || input.startsWith('query')) {
      reply = (
        <div style={{ color: '#38bdf8' }}>
          <p>✔ task: "Explain PtyManager state machine"</p>
          <p>✔ retrieved: 4 relevant files, 14 symbols, 0 secrets</p>
          <p style={{ color: '#34d399' }}>✔ token footprint: 1,420 tokens (68% savings vs raw dump)</p>
        </div>
      );
    } else if (['claude', 'codex', 'gemini', 'ai'].includes(input) || input.startsWith('kai ')) {
      reply = (
        <div style={{ color: '#d8b4fe' }}>
          <p>codex <span style={{ color: '#34d399' }}>✓</span> /usr/local/bin/codex · claude <span style={{ color: '#34d399' }}>✓</span> /usr/bin/claude · gemini <span style={{ color: '#34d399' }}>✓</span> ~/bin/gemini</p>
          <p style={{ color: '#94a3b8', fontSize: '0.75rem' }}>kai never bundles AI binaries — you own keys + execution.</p>
        </div>
      );
    } else if (['downloads', 'download', 'install'].includes(input)) {
      reply = (
        <div style={{ color: '#67e8f9' }}>
          <p>.exe/.msi · .deb/.AppImage · .dmg (Apple Silicon)</p>
          <p style={{ color: '#94a3b8' }}>open the /download page ↓</p>
        </div>
      );
    } else if (['version', 'kai --version'].includes(input)) {
      reply = <p style={{ color: '#67e8f9' }}>kai {version} — Tauri 2.1 + Rust · MIT</p>;
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

  const chips = ['kai status', 'kai mcp .', 'kai query', 'help'];

  return (
    <div className="t-terminal" role="region" aria-label="Interactive Kai preview terminal">
      <div className="t-terminal-bar">
        <div className="t-terminal-dots">
          <span className="t-dot" style={{ backgroundColor: '#ef4444' }}></span>
          <span className="t-dot" style={{ backgroundColor: '#f59e0b' }}></span>
          <span className="t-dot" style={{ backgroundColor: '#10b981' }}></span>
          <span className="t-terminal-title">kai — zsh</span>
        </div>
        <div className="t-terminal-chips">
          {chips.map((c) => (
            <button key={c} type="button" onClick={() => run(c)} className="t-chip">
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
