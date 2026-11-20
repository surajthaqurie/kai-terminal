# Kai Terminal — Design System

**Quiet chrome, meaningful cyan.** Surfaces are neutral and flat and separate by tone
(sunken < surface < elevated), not by borders. The accent marks only focus, the active selection and
the place input goes. Semantic colours (success / warning / danger / info) mark only real state, and
never alone: every state also has a shape, icon or words. The terminal is the primary surface.

Stack: React 19 + TypeScript, plain CSS custom properties, `lucide-react`. No CSS framework.

## CSS organisation

`src/main.tsx` imports `src/fonts.css` and `src/styles/index.css`. **Import order is cascade order.**

```
src/styles/
├─ index.css            entry; documents the layer order
├─ tokens/
│  ├─ primitives.css    theme-agnostic scales (type, weight, spacing, control, z, motion, radii, shadow, terminal)
│  └─ semantic.css      derived aliases: chrome sub-surfaces, state, focus, info, pane tokens
├─ themes/              GENERATED from src/theme/registry.ts (colour tokens only) — see THEMES.md
├─ base.css             reset, focus ring, global reduced motion, scrollbars, .sr-only, layout utilities
├─ primitives/          kbd, badge, banner, dialog (new) · menu, button, input, toast, modal
├─ shell/               layout, tab-bar, header, terminal, panes, search, palette, status-bar,
│                       responsive, shell-picker
└─ features/            settings, ai-providers, update, git, workspace, music, integrations,
                        translucency, music-pip, shared-agent
```

The shell/feature files are contiguous slices of the former 8,008-line `App.css`, imported in their
original order (verified rule-for-rule when split), so the split changed no cascade or specificity.

**Layering rule:** features use primitives and semantic tokens — never theme literals or raw scale
values. A theme colour token (`--accent-primary: …`) declared outside `themes/` fails a test.

## Tokens

| Group | Tokens | Notes |
|---|---|---|
| Surfaces | `--bg-canvas`, `--bg-surface`, `--bg-surface-sunken`, `--bg-surface-elevated`, `--bg-header`, `--bg-overlay` | per theme |
| Chrome aliases | `--bg-tab-bar`, `--bg-statusbar`, `--bg-tab-active/inactive/hover`, `--bg-card` | derived, `semantic.css` |
| Borders | `--border-subtle/default/strong/accent` | strong = divider (≥1.6:1 tested) |
| Text | `--text-primary/secondary/tertiary/inverse` | hierarchy tested per theme |
| Accent | `--accent-primary/hover/subtle/glow/ring` | `subtle` = selected-row tint |
| Semantic | `--color-{success,warning,danger,purple}` + `-bg`, `--color-info(-bg)` | |
| State | `--state-hover`, `--state-active`, `--state-disabled-opacity`, `--focus-ring-color/width` | derived from text colour → works in light and dark |
| Panes | `--pane-ring-active`, `--pane-inactive-dim` | |
| Type | `--text-micro` 10 (music counters only), `--text-xs` 11 (UI floor), `sm` 12, `base` 13, `md` 14, `lg` 16, `xl` 18; `--weight-medium/semibold/bold`; `--leading-normal` | |
| Spacing | `--space-1` 4, `-1-5` 6, `-2` 8, `-3` 12, `-4` 16 | add steps only when a rule needs them |
| Controls | `--control-h-sm` 24, `--control-h-md` 28 | |
| Layers | `--z-overlay-in-pane` 100, `--z-drawer` 900, `--z-modal` 1000, `--z-menu` 1200, `--z-pinned` 2100, `--z-toast` 2200 | values < 100 are local stacking inside one component |
| Motion | `--duration-fast`, `--ease-standard`, `--transition-fast` | |
| Terminal | `--terminal-padding-x/y` | set per pane from Settings |
| Tab colours | `--tab-color-{blue,green,yellow,red,purple,teal,orange,gray}` | per theme, generated |

Guardrails (`designTokens.test.ts`): every `var()` resolves (allow-list: runtime variables `--tab-color`,
`--win-alpha`, `--music-*`); no fallback on a real token; no unused token; no foreign Tailwind
indigo/violet/red; no z-index ≥ 100 outside the layer tokens; no raw px font size below 14px.

## Primitives (`src/components/ui`)

Thin React components over the classes above. They add structure and accessibility, not visuals.

| Component | Use | Notes |
|---|---|---|
| `Button` | text buttons | `variant` primary / secondary / **danger** (irreversible only) / ghost; `size` sm/md; `type="button"` by default; disabled styling via `.btn:disabled` |
| `IconButton` | icon-only buttons | `label` is required (aria-label + tooltip); `danger` for destructive |
| `Dialog` | modal dialogs | backdrop, `role="dialog"`, `aria-modal`, labelled by its title; focus in / Tab trap / Escape / focus return via `useModalBehavior` |
| `Menu` | menus | re-export of the existing `PopupMenu` (menu button + roving focus); not duplicated |
| `Badge` | small status labels | `tone` neutral / info / success / warning / danger; words carry the meaning |
| `Banner` | app-level notices | `tone`; danger/warning use `role="alert"`, others `role="status"`; severity = left stripe |
| `Kbd` | shortcut labels | |

Toasts keep `ToastHost` (already role-correct). Inline in-panel notices use `.inline-notice` with the same
neutral-frame + severity-stripe pattern as `Banner`.

## Interaction states

Every interactive element has: hover (`--state-hover` or a surface step), a visible keyboard focus
(global `:focus-visible` outline; inputs/sliders/palette/diff body have explicit replacements), active,
and disabled (`opacity: var(--state-disabled-opacity)`, `cursor: not-allowed`, hover/press gated with
`:not(:disabled)`). `transition: all` is not used; transitions list their properties.

## Terminal shell conventions

- **Tab status**: connecting = spinner (warning), running = terminal glyph, exited = slashed circle +
  italic tertiary title, failed = alert icon (danger). State is also in the tab's accessible name.
- **Split panes**: only when split — active pane gets a 1px accent ring, inactive panes a canvas veil,
  each pane a 20px folder label (live cwd). A single pane has no frame. xterm is never remounted.
- **Search**: `n of m` / `No results` / `N+ matches` from the search addon's result event.
- **Launch failure**: one overlay (danger stripe, error detail, OS-specific tip, Retry) + one dim ANSI line.

## Accessibility requirements

WCAG 2.1 AA text contrast in every theme (see THEMES.md); colour is never the only signal; every dialog
is `role="dialog"` + `aria-modal` with focus management; the command palette is a combobox/listbox with
`aria-activedescendant`; live regions are scoped (toasts, notices, search count), the status bar is not
one; `prefers-reduced-motion` disables all animation globally; icon-only controls require a label.

## Testing

```
npx tsc --noEmit
npx vitest run                       # whole suite
npx vitest run src/__tests__/{designTokens,themeRegistry,themeContrast,startupPaint,uiRefinement,paneDividerContrast,terminalUx,uiPrimitives,terminalLayoutSettings}.test.*
npm run themes:generate              # after editing src/theme/registry.ts
npx prettier --check "src/**/*.{ts,tsx,css,json}"
npx vite build
```

Tests that inspect CSS read the whole stylesheet through `src/__tests__/helpers/styles.ts`
(`readStylesheet()` inlines `@import`s in order), so moving a rule between files never hides it.
