// Contrast audit for kai-website Charcoal + Cyan tokens.
// Parses src/theme/tokens.css, resolves var() aliases, checks WCAG ratios.
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'theme', 'tokens.css'), 'utf8');

function blockVars(name) {
  const re = name === 'dark'
    ? /:root\s*,\s*\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/
    : /\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/;
  const m = css.match(re);
  if (!m) throw new Error('block not found: ' + name);
  const vars = {};
  const varRe = /--([a-z0-9-]+)\s*:\s*([^;]+);/g;
  let v;
  while ((v = varRe.exec(m[1])) !== null) vars['--' + v[1]] = v[2].trim();
  return vars;
}

function resolve(vars, val, depth = 0) {
  const m = /var\((--[a-z0-9-]+)\)/.exec(val);
  if (!m || depth > 5) return val;
  const inner = vars[m[1]];
  if (!inner) throw new Error('unresolved ' + m[1]);
  if (/var\(/.test(inner)) throw new Error('nested/self-ref ' + m[1] + ' = ' + inner);
  return inner;
}

function px(h) {
  h = h.trim().toLowerCase();
  if (h.length === 4) h = '#' + h.slice(1).split('').map((c) => c + c).join('');
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function lum([r, g, b]) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function cr(fg, bg) {
  const l1 = lum(px(fg)), l2 = lum(px(bg));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
function comp(r, g, b, a, bg) {
  const [br, bg2, bb] = px(bg);
  const h = (v) => Math.round(v).toString(16).padStart(2, '0');
  return '#' + h(r * a + br * (1 - a)) + h(g * a + bg2 * (1 - a)) + h(b * a + bb * (1 - a));
}

const dark = blockVars('dark');
const light = blockVars('light');
let fails = 0;
function check(theme, vars, fg, bg, min, label) {
  const F = resolve(vars, vars[fg] || fg);
  const B = resolve(vars, vars[bg] || bg);
  const r = cr(F, B);
  const ok = r >= min;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} [${theme}] ${label}: ${F} on ${B} = ${r.toFixed(2)} (min ${min})`);
}

const S = '--surface';
// Dark text on surface
check('dark', dark, '--text-primary', S, 4.5, 'primary text');
check('dark', dark, '--text-secondary', S, 4.5, 'secondary text');
check('dark', dark, '--text-tertiary', S, 4.5, 'tertiary text');
check('dark', dark, '--accent', S, 4.5, 'accent text');
check('dark', dark, '--success', S, 4.5, 'success text');
check('dark', dark, '--warning', S, 4.5, 'warning text');
check('dark', dark, '--info', S, 4.5, 'info text');
check('dark', dark, '--accent-purple-fg', S, 4.5, 'purple text');
check('dark', dark, '--accent-red-fg', S, 4.5, 'danger text');
// Dark: primary button, muted/tertiary on canvas + sunken, error in terminal
check('dark', dark, '--text-inverse', '--accent', 4.5, 'primary button text');
check('dark', dark, '--text-tertiary', '--background', 4.5, 'tertiary on canvas');
check('dark', dark, '--text-muted', '--terminal-background', 4.5, 'muted on terminal');
check('dark', dark, '--error', '--terminal-background', 4.5, 'error in terminal');
check('dark', dark, '--success', '--terminal-background', 4.5, 'success in terminal');
check('dark', dark, '--warning', '--terminal-background', 4.5, 'warning in terminal');
check('dark', dark, '--accent', '--terminal-background', 4.5, 'cyan in terminal');
// Dark badges (composited)
for (const [fg, rgb] of [
  ['--success', [16, 185, 129]], ['--warning', [245, 158, 11]],
  ['--accent-red-fg', [239, 68, 68]], ['--accent-purple-fg', [167, 139, 250]],
]) {
  const F = resolve(dark, dark[fg]);
  const B = comp(...rgb, 0.12, resolve(dark, dark[S]));
  const r = cr(F, B);
  const ok = r >= 4.5;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} [dark] badge ${fg}: ${F} on ${B} = ${r.toFixed(2)} (min 4.5)`);
}
// Light text on surface
check('light', light, '--text-primary', S, 4.5, 'primary text');
check('light', light, '--text-secondary', S, 4.5, 'secondary text');
check('light', light, '--text-tertiary', S, 4.5, 'tertiary text');
check('light', light, '--accent-cyan-fg', S, 4.5, 'interactive cyan text');
check('light', light, '--success', S, 4.5, 'success text');
check('light', light, '--warning', S, 4.5, 'warning text');
check('light', light, '--error', S, 4.5, 'error text');
check('light', light, '--info', S, 4.5, 'info text');
check('light', light, '--accent-purple-fg', S, 4.5, 'purple text');
check('light', light, '--accent-red-fg', S, 4.5, 'danger text');
// Light: primary button + hover, tertiary on canvas
console.log((cr('#fff', '#0e7490') >= 4.5 ? 'PASS' : 'FAIL') + ` [light] primary button: #fff on #0e7490 = ${cr('#fff', '#0e7490').toFixed(2)}`);
if (cr('#fff', '#0e7490') < 4.5) fails++;
console.log((cr('#fff', '#155e75') >= 4.5 ? 'PASS' : 'FAIL') + ` [light] primary hover: #fff on #155e75 = ${cr('#fff', '#155e75').toFixed(2)}`);
if (cr('#fff', '#155e75') < 4.5) fails++;
check('light', light, '--text-tertiary', '--background', 4.5, 'tertiary on canvas');
// Light badges
for (const [fg, rgb, a] of [
  ['--success', [4, 120, 87], 0.08], ['--warning', [180, 83, 9], 0.06],
  ['--error', [185, 28, 28], 0.07], ['--accent-purple-fg', [109, 40, 217], 0.08],
  ['--accent-cyan-fg', [8, 145, 178], 0.08],
]) {
  const F = resolve(light, light[fg]);
  const B = comp(...rgb, a, resolve(light, light[S]));
  const r = cr(F, B);
  const ok = r >= 4.5;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} [light] badge ${fg}: ${F} on ${B} = ${r.toFixed(2)} (min 4.5)`);
}
console.log(fails === 0 ? '\nALL CONTRAST CHECKS PASSED' : `\n${fails} CHECKS FAILED`);
process.exit(fails === 0 ? 0 : 1);
