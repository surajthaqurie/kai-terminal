import React from 'react';
import { renderToString } from 'react-dom/server';

// Minimal browser stubs for render-phase access (effects never run in SSR).
(globalThis as any).window = {
  location: { pathname: '/mcp', hash: '' },
  addEventListener: () => {},
  removeEventListener: () => {},
};
(globalThis as any).localStorage = {
  getItem: () => null,
  setItem: () => {},
};

async function main() {
  const { default: App } = await import('../src/App');
  let html = '';
  try {
    html = renderToString(<App />);
  } catch (err) {
    console.error('RENDER THREW:', err);
    process.exit(1);
  }
  const checks: Array<[string, boolean]> = [
    ['app shell rendered', html.length > 1000],
    ['header brand present', html.includes('t-brand')],
    ['hero title "MCP"', html.includes('>MCP</h1>')],
    ['hero MCP.md link', html.includes('>MCP.md</a>')],
    ['intro paragraph removed', !html.includes('runs automatically over stdio')],
    ['Commands section present', html.includes('Connect an Agent')],
    ['footer present', html.includes('t-footer')],
  ];
  let fail = 0;
  for (const [label, ok] of checks) {
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  }
  if (fail > 0) {
    console.log('---HTML---');
    console.log(html.slice(0, 1500));
    process.exit(1);
  }
  console.log('FULL /mcp APP RENDERS OK, length=' + html.length);
}

main();
