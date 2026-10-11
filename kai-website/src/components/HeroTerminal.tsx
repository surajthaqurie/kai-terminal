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
          <p>try: <b style={{ color: '#fcd34d' }}>status</b> · <b style={{ color: '#fcd34d' }}>mcp</b> · <b style={{ color: '#fcd34d' }}>query</b> · <b style={{ color: '#fcd34d' }}>downloads</b> · <b style={{ color: '#fcd34d' }}>clear</b></p>
        </div>
      );
    } else if (['status', 'kai --status', 'kai status'].includes(input)) {
      reply = (
        <div style={{ color: '#34d399' }}>
          <p>✔ Kai is working well</p>
          <p>✔ Fast display · Low memory (~30MB)</p>
          <p>✔ Ready to help your AI tool</p>
        </div>
      );
    } else if (['mcp', 'kai mcp', 'kai mcp .'].includes(input)) {
      reply = (
        <div style={{ color: '#34d399' }}>
          <p>[kai] Ready to help your AI tool</p>
          <p style={{ color: '#a78bfa' }}>Can: find code · explain files · answer questions</p>
          <p style={{ color: '#94a3b8', fontSize: '0.75rem' }}>Fast · Private · Nothing leaves your computer</p>
        </div>
      );
    } else if (input.startsWith('kai query') || input.startsWith('query')) {
      reply = (
        <div style={{ color: '#38bdf8' }}>
          <p>✔ question: "Where is the login code?"</p>
          <p>✔ found: 4 files, only the needed parts</p>
          <p style={{ color: '#34d399' }}>✔ low cost: 68% cheaper than sharing all files</p>
        </div>
      );
    } else if (['claude', 'codex', 'gemini', 'copilot', 'opencode', 'aider', 'windsurf', 'cline', 'ai'].includes(input) || input.startsWith('kai agent') || input.startsWith('kai ')) {
      reply = (
        <div style={{ color: '#d8b4fe' }}>
          <p>codex <span style={{ color: '#34d399' }}>✓</span> · claude <span style={{ color: '#34d399' }}>✓</span> · gemini <span style={{ color: '#34d399' }}>✓</span> · copilot <span style={{ color: '#34d399' }}>✓</span> · opencode <span style={{ color: '#34d399' }}>✓</span> · aider <span style={{ color: '#34d399' }}>✓</span></p>
          <p style={{ color: '#94a3b8', fontSize: '0.75rem' }}>Connect one with: kai agent setup &lt;name&gt;. Example: kai agent setup claude.</p>
        </div>
      );
    } else if (['downloads', 'download', 'install'].includes(input)) {
      reply = (
        <div style={{ color: '#67e8f9' }}>
          <p>.exe / .msi · .deb / .AppImage · .dmg (macOS)</p>
          <p style={{ color: '#94a3b8' }}>open the /download page ↓</p>
        </div>
      );
    } else if (['version', 'kai --version'].includes(input)) {
      reply = <p style={{ color: '#67e8f9' }}>Kai {version} — Free and private</p>;
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
