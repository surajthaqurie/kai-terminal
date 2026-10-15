'use client';

import React, { useEffect, useRef, useState } from 'react';

export function HeroTerminal({ version }: { version: string }) {
  const [terminalInput, setTerminalInput] = useState('');
  const [cursorPos, setCursorPos] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef<string[]>(['kai health']);
  const historyIndexRef = useRef<number>(-1);

  const [terminalHistory, setTerminalHistory] = useState<
    Array<{ cmd: string; output: React.ReactNode }>
  >([
    {
      cmd: 'kai health',
      output: (
        <div style={{ color: '#10b981' }}>
          <p>✔ Kai {version} is ready</p>
          <p>✔ Fast and private · Free</p>
        </div>
      ),
    },
  ]);

  const run = (rawInput: string) => {
    const input = rawInput.trim().toLowerCase();
    if (!input) return;
    historyRef.current.push(rawInput.trim());
    historyIndexRef.current = -1;

    let reply: React.ReactNode = '';
    if (['help', '?', 'kai --help', 'kai -h'].includes(input)) {
      reply = (
        <div style={{ color: '#22d3ee' }}>
          <p>try: <b style={{ color: '#f59e0b' }}>open</b> · <b style={{ color: '#f59e0b' }}>&lt;agent&gt;</b> · <b style={{ color: '#f59e0b' }}>health</b> · <b style={{ color: '#f59e0b' }}>list</b> · <b style={{ color: '#f59e0b' }}>setup</b> · <b style={{ color: '#f59e0b' }}>graph</b> · <b style={{ color: '#f59e0b' }}>remove</b> · <b style={{ color: '#f59e0b' }}>doctor</b> · <b style={{ color: '#f59e0b' }}>lsp</b> · <b style={{ color: '#f59e0b' }}>stop</b> · <b style={{ color: '#f59e0b' }}>close</b></p>
        </div>
      );
    } else if (['kai', 'kai help'].includes(input)) {
      reply = (
        <div style={{ color: '#22d3ee' }}>
          <p>Kai CLI — local project intelligence & agent launcher</p>
          <p>try: <b style={{ color: '#f59e0b' }}>kai open</b> · <b style={{ color: '#f59e0b' }}>kai health</b> · <b style={{ color: '#f59e0b' }}>kai list</b> · <b style={{ color: '#f59e0b' }}>kai &lt;agent&gt; .</b> · <b style={{ color: '#f59e0b' }}>help</b></p>
        </div>
      );
    } else if (['open', 'kai open', 'kai open .'].includes(input) || input.startsWith('kai open ')) {
      reply = (
        <div style={{ color: '#10b981' }}>
          <p>[kai] Opened Kai Terminal for "web-app" (/home/dev/projects/web-app)</p>
          <p style={{ color: '#9ca3af', fontSize: '0.75rem' }}>Launches or focuses the Kai Terminal desktop app for your project.</p>
        </div>
      );
    } else if (['close', 'kai close'].includes(input)) {
      reply = (
        <div style={{ color: '#22d3ee' }}>
          <p>[kai] Kai Terminal instances closed.</p>
        </div>
      );
    } else if (['health', 'kai --health', 'kai health'].includes(input)) {
      reply = (
        <div style={{ color: '#10b981' }}>
          <p>✔ Kai {version} is ready</p>
          <p>✔ Fast and private · Free</p>
        </div>
      );
    } else if (['status', 'kai --status', 'kai status'].includes(input)) {
      reply = (
        <div style={{ color: '#9ca3af' }}>
          <p>[kai] 'kai status' has been replaced by 'kai health' (and 'kai graph status' for code-map state).</p>
        </div>
      );
    } else if (['list', 'kai list', 'kai list -a', 'kai list --agent'].includes(input)) {
      reply = (
        <div style={{ color: '#9ca3af' }}>
          <p>[kai] Tools (live system probe):</p>
          <p>  <span style={{ color: '#10b981' }}>✓</span> my-tool-a   Installed · connected <span style={{ color: '#10b981' }}>✓</span></p>
          <p>  <span style={{ color: '#10b981' }}>✓</span> my-tool-b   Installed · not connected</p>
          <p style={{ color: '#9ca3af', fontSize: '0.75rem' }}>Run 'kai setup all' to connect every installed tool.</p>
        </div>
      );
    } else if (['kai list -i', 'kai list --index'].includes(input)) {
      reply = (
        <div style={{ color: '#9ca3af' }}>
          <p>[kai] Indexed Projects (1):</p>
          <p>  • web-app (id: e2b57f01a8cd3241)</p>
          <p>    Status: ready (fresh) · Files: 142 · Symbols: 890</p>
        </div>
      );
    } else if (['kai list -s', 'kai list --session'].includes(input)) {
      reply = (
        <div style={{ color: '#9ca3af' }}>
          <p>[kai] Sessions & cache:</p>
          <p>  Sessions: 1 file · Cache: 1 file</p>
        </div>
      );
    } else if (['kai <agent>', 'kai <agent> .'].includes(input) || input.startsWith('kai claude') || input.startsWith('kai cursor')) {
      reply = (
        <div style={{ color: '#38bdf8' }}>
          <p>[kai] Tool connected for this project.</p>
          <p>[kai] Running task in "web-app".</p>
          <p style={{ color: '#9ca3af' }}>... [Tool session completed with exit code 0] ...</p>
          <p style={{ color: '#10b981' }}>[kai] Task finished. Map updated (3 files).</p>
        </div>
      );
    } else if (['setup', 'kai setup', 'kai setup all', 'kai setup <agent>'].includes(input)) {
      reply = (
        <div style={{ color: '#38bdf8' }}>
          <p>[kai] Tool settings updated for this project.</p>
          <p>[kai] Previous settings backed up.</p>
          <p style={{ color: '#10b981' }}>[kai] Restart your tool so it picks up the change.</p>
        </div>
      );
    } else if (['remove', 'kai remove', 'kai remove -i .'].includes(input) || input.startsWith('kai remove')) {
      reply = (
        <div style={{ color: '#ef4444' }}>
          <p>[kai] Project "web-app" map deleted.</p>
          <p style={{ color: '#9ca3af', fontSize: '0.75rem' }}>NOTE: Your code was NOT touched.</p>
        </div>
      );
    } else if (['graph', 'kai graph', 'kai graph status', 'kai graph init', 'kai graph update'].includes(input)) {
      reply = (
        <div style={{ color: '#10b981' }}>
          <p>[kai] Map for "web-app":</p>
          <p>  Files: 142 · Symbols: 890 · State: ready</p>
          <p style={{ color: '#9ca3af', fontSize: '0.75rem' }}>Updates when the tool session ends</p>
        </div>
      );
    } else if (['stop', 'kai stop'].includes(input)) {
      reply = <p style={{ color: '#22d3ee' }}>[kai] Tool mode cleared — back to plain terminal.</p>;
    } else if (['doctor', 'kai doctor'].includes(input)) {
      reply = (
        <div style={{ color: '#22d3ee' }}>
          <p>[kai] Doctor — setup check (kai {version}):</p>
          <p>  Desktop app: found <span style={{ color: '#10b981' }}>✓</span> · Data folder: ready <span style={{ color: '#10b981' }}>✓</span></p>
        </div>
      );
    } else if (['lsp', 'kai lsp'].includes(input)) {
      reply = (
        <div style={{ color: '#38bdf8' }}>
          <p>[kai] Language Server Protocol (LSP) Bridge Status:</p>
          <p>  <span style={{ color: '#10b981' }}>✓</span> typescript (typescript-language-server)</p>
          <p>  <span style={{ color: '#10b981' }}>✓</span> python (pyright) · <span style={{ color: '#10b981' }}>✓</span> rust (rust-analyzer)</p>
        </div>
      );
    } else if (['metrics', 'kai metrics'].includes(input)) {
      reply = (
        <div style={{ color: '#22d3ee' }}>
          <p>[kai] Local stats:</p>
          <p>  Runs: 38 · Avg time: 12ms</p>
        </div>
      );
    } else if (['downloads', 'download', 'install'].includes(input)) {
      reply = (
        <div style={{ color: '#22d3ee' }}>
          <p>.dmg (macOS) · .deb / .AppImage (Linux) · .exe / .msi (Windows)</p>
          <p style={{ color: '#9ca3af' }}>Visit the /download page to pick your installer</p>
        </div>
      );
    } else if (['version', 'kai --version'].includes(input)) {
      reply = <p style={{ color: '#22d3ee' }}>Kai {version} — MIT licensed, Tauri 2 + Rust</p>;
    } else if (['ls', 'dir'].includes(input)) {
      reply = <p style={{ color: '#9ca3af' }}>src/ src-tauri/ packaging/ Cargo.toml package.json</p>;
    } else if (input === 'clear' || input === 'cls') {
      setTerminalHistory([]);
      setTerminalInput('');
      setCursorPos(0);
      return;
    } else {
      reply = <p style={{ color: '#ef4444' }}>not found: '{rawInput}'. type 'help'.</p>;
    }
    setTerminalHistory((prev) => [...prev, { cmd: rawInput, output: reply }]);
    setTerminalInput('');
    setCursorPos(0);
  };

  useEffect(() => {
    const el = viewRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [terminalHistory]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    run(terminalInput);
  };

  const handleChipClick = (cmd: string) => {
    run(cmd);
    inputRef.current?.focus();
  };

  const handleViewClick = (e: React.MouseEvent) => {
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    inputRef.current?.focus();
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTerminalInput(e.target.value);
    setCursorPos(e.target.selectionStart ?? e.target.value.length);
    historyIndexRef.current = -1;
  };

  const onSelectOrKey = (e: React.SyntheticEvent<HTMLInputElement>) => {
    const target = e.currentTarget;
    setCursorPos(target.selectionStart ?? target.value.length);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const history = historyRef.current;
      if (history.length === 0) return;
      const nextIdx =
        historyIndexRef.current === -1
          ? history.length - 1
          : Math.max(0, historyIndexRef.current - 1);
      historyIndexRef.current = nextIdx;
      const val = history[nextIdx];
      setTerminalInput(val);
      setCursorPos(val.length);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const history = historyRef.current;
      if (historyIndexRef.current === -1) return;
      const nextIdx = historyIndexRef.current + 1;
      if (nextIdx >= history.length) {
        historyIndexRef.current = -1;
        setTerminalInput('');
        setCursorPos(0);
      } else {
        historyIndexRef.current = nextIdx;
        const val = history[nextIdx];
        setTerminalInput(val);
        setCursorPos(val.length);
      }
    }
  };

  const chips = ['kai open', 'kai claude .', 'kai health', 'kai list -a', 'kai graph status', 'help'];

  const isAtEnd = cursorPos >= terminalInput.length;
  const beforeCursorText = terminalInput.slice(0, cursorPos);
  const cursorChar = terminalInput.slice(cursorPos, cursorPos + 1);
  const afterCursorText = terminalInput.slice(cursorPos + 1);

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
            <button
              key={c}
              type="button"
              onClick={() => handleChipClick(c)}
              className="t-chip"
              title={`Run ${c}`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="t-terminal-view" ref={viewRef} onClick={handleViewClick}>
        {terminalHistory.map((item, idx) => (
          <div key={idx} className="t-term-line">
            <div className="t-term-prompt">
              <span>➜ ~</span>
              <span className="t-term-cmd">{item.cmd}</span>
            </div>
            <div className="t-term-out">{item.output}</div>
          </div>
        ))}
        <form onSubmit={onSubmit} className="t-term-form" onClick={() => inputRef.current?.focus()}>
          <span className="t-term-prompt-symbol">➜ ~</span>
          <div className="t-term-input-wrap">
            <div className="t-term-input-visual" aria-hidden="true">
              {terminalInput.length === 0 ? (
                <>
                  <span className="t-term-cursor" />
                  <span className="t-term-placeholder">type 'help' + enter — it's live</span>
                </>
              ) : isAtEnd ? (
                <>
                  <span className="t-term-text">{terminalInput}</span>
                  <span className="t-term-cursor" />
                </>
              ) : (
                <>
                  <span className="t-term-text">{beforeCursorText}</span>
                  <span className="t-term-cursor t-term-cursor--char">{cursorChar}</span>
                  <span className="t-term-text">{afterCursorText}</span>
                </>
              )}
            </div>
            <input
              ref={inputRef}
              type="text"
              value={terminalInput}
              onChange={onInputChange}
              onKeyDown={onKeyDown}
              onSelect={onSelectOrKey}
              onKeyUp={onSelectOrKey}
              className="t-term-input"
              aria-label="Preview terminal input"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        </form>
      </div>
    </div>
  );
}
