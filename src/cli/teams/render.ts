import { rowsForImage } from "../../core/teams/images";
import { ellipsize, padRight, renderParts, textWidth, wrap, type Part } from "./ansi";

/**
 * Lays out one screenful of the Teams chat. `layout` is a pure function from
 * the view state and the terminal size to rows of text, the clickable regions
 * and where inline images go, so it can be tested without a terminal.
 */

export type NoticeKind = "info" | "ok" | "error";

export interface ViewImage {
  name: string;
  /** The site a click opens in the browser, shown so a link cannot pass for a picture. */
  host?: string;
  /** `inline`: loaded and drawable; `link`: shown as a clickable line. */
  state: "inline" | "link";
  b64?: string;
  width?: number;
  height?: number;
}

export interface ViewMessage {
  id: string;
  time: string;
  /** Local calendar day (YYYY-MM-DD) for date separators. */
  day: string;
  from: string;
  mine: boolean;
  system: boolean;
  text: string;
  images: ViewImage[];
  files: Array<{ name: string; host?: string }>;
  /** Still being sent from here: shown dim with "sending". */
  pending?: boolean;
}

export interface SidebarItem {
  kind: "heading" | "team" | "item" | "note";
  label: string;
  key?: string;
  selected?: boolean;
  /** Has messages you have not seen. */
  unread?: boolean;
}

export interface PendingView {
  name: string;
  size: string;
  image: boolean;
}

export interface ViewModel {
  headerLeft: string;
  headerRight: string;
  sidebar: SidebarItem[];
  convTitle: string;
  messages: ViewMessage[];
  /** A line shown instead of messages (loading, nothing here, an error). */
  convNote: { text: string; kind: NoticeKind } | null;
  /** Whether older messages can be loaded above the first one shown. */
  older: "none" | "available" | "loading";
  /** Lines the view is scrolled up from the newest message. */
  scroll: number;
  input: string;
  /** Index into `input` (UTF-16 code units). */
  cursor: number;
  pending: PendingView[];
  notice: { text: string; kind: NoticeKind } | null;
  typing: string;
}

export type Action =
  | { type: "select"; key: string }
  | { type: "attach" }
  | { type: "send" }
  | { type: "unattach"; index: number }
  | { type: "older" }
  | { type: "open"; messageId: string; kind: "image" | "file"; index: number };

export interface Hit {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  action: Action;
}

export interface Placement {
  /** Stable id so the renderer can tell whether an image moved. */
  id: string;
  row: number;
  col: number;
  cols: number;
  rows: number;
  b64: string;
  name: string;
}

export interface Frame {
  rows: string[];
  hits: Hit[];
  images: Placement[];
  cursor: { x: number; y: number };
  /** The message pane, for wheel scrolling. */
  pane: { x1: number; y1: number; x2: number; y2: number };
  maxScroll: number;
}

export const MIN_COLS = 40;
export const MIN_ROWS = 10;
const FOOTER_ROWS = 4;
const MAX_IMAGE_COLS = 44;
const MAX_IMAGE_ROWS = 14;

const SGR = {
  head: "30;46;1",
  dim: "2",
  bold: "1",
  cyan: "36",
  sel: "36;1;7",
  selBg: "7",
  ok: "32",
  err: "31",
  info: "33",
  purple: "35",
  chip: "35",
  button: "30;46",
  mine: "36;1",
};
const NAME_COLORS = ["33", "35", "32", "31", "34", "36"];

function nameColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length];
}

interface ConvLine {
  parts: Part[];
  hit?: Action;
  /** Set on the first line of an inline image; its remaining rows follow as blank lines. */
  image?: { id: string; cols: number; rows: number; b64: string; name: string };
}

function sizeLabel(n: number): string {
  return n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

export function formatSize(bytes: number): string {
  return sizeLabel(bytes);
}

/** What a clickable line says it will do: open here, or open a named site in the browser. */
function openHint(host?: string): string {
  return host ? `  opens ${host} in your browser` : "  click to open";
}

function convLines(vm: ViewModel, width: number): ConvLine[] {
  const lines: ConvLine[] = [];
  let lastDay = "";
  if (vm.older === "available") {
    lines.push({
      parts: [[SGR.dim, "\u25b2 earlier messages (scroll up, or click here)"]],
      hit: { type: "older" },
    });
  } else if (vm.older === "loading") {
    lines.push({ parts: [[SGR.dim, "... loading earlier messages"]] });
  }
  for (const m of vm.messages) {
    if (m.day && m.day !== lastDay) {
      lastDay = m.day;
      lines.push({ parts: [[SGR.dim, `── ${m.day} ──`]] });
    }
    if (m.system) {
      for (const l of wrap(m.text || "(system message)", width - 2)) {
        lines.push({ parts: [[SGR.dim, `  ${l}`]] });
      }
      continue;
    }
    const color = m.mine ? SGR.mine : `${nameColor(m.from)};1`;
    lines.push({
      parts: [
        [SGR.dim, `${m.time} `],
        [color, m.mine ? "You" : m.from],
        ...(m.pending ? ([[SGR.dim, "  sending..."]] as Part[]) : []),
      ],
    });
    if (m.text) for (const l of wrap(m.text, width - 2)) lines.push({ parts: [["", `  ${l}`]] });
    m.images.forEach((img, index) => {
      const open: Action = { type: "open", messageId: m.id, kind: "image", index };
      if (img.state === "inline" && img.b64) {
        const cols = Math.max(8, Math.min(MAX_IMAGE_COLS, width - 4));
        const rows = rowsForImage(
          { width: img.width ?? 0, height: img.height ?? 0 },
          cols,
          MAX_IMAGE_ROWS
        );
        lines.push({
          parts: [],
          hit: open,
          image: { id: `${m.id}:${index}`, cols, rows, b64: img.b64, name: img.name },
        });
        for (let r = 1; r < rows; r++) lines.push({ parts: [], hit: open });
      } else {
        lines.push({
          parts: [
            ["", "  "],
            [SGR.purple, `▣ ${img.name || "image"}`],
            [SGR.dim, openHint(img.host)],
          ],
          hit: open,
        });
      }
    });
    m.files.forEach((f, index) => {
      lines.push({
        parts: [
          ["", "  "],
          [SGR.purple, `◆ ${f.name}`],
          [SGR.dim, openHint(f.host)],
        ],
        hit: { type: "open", messageId: m.id, kind: "file", index },
      });
    });
    lines.push({ parts: [] });
  }
  return lines;
}

/** Index of the sidebar row to start from so the selected row stays in view. */
function sidebarStart(items: SidebarItem[], height: number): number {
  const sel = items.findIndex((i) => i.selected);
  if (sel < 0 || items.length <= height) return 0;
  return Math.max(0, Math.min(sel - Math.floor(height / 2), items.length - height));
}

export function layout(vm: ViewModel, cols: number, rows: number): Frame {
  if (cols < MIN_COLS || rows < MIN_ROWS) {
    const msg = `Make the window bigger (at least ${MIN_COLS}x${MIN_ROWS}).`;
    const blank = " ".repeat(cols);
    const out = Array.from({ length: rows }, (_, i) => (i === 0 ? padRight(msg, cols) : blank));
    return {
      rows: out,
      hits: [],
      images: [],
      cursor: { x: 1, y: 1 },
      pane: { x1: 1, y1: 1, x2: 1, y2: 1 },
      maxScroll: 0,
    };
  }

  const sideW = cols < 64 ? 0 : Math.max(18, Math.min(32, Math.floor(cols * 0.28)));
  const paneX = sideW > 0 ? sideW + 2 : 1;
  const paneW = cols - paneX + 1;
  const bodyTop = 2;
  const bodyH = rows - 1 - FOOTER_ROWS;
  const bodyBottom = bodyTop + bodyH - 1;
  const hits: Hit[] = [];
  const out: string[] = [];

  // Header
  const right = vm.headerRight;
  const left = ellipsize(vm.headerLeft, Math.max(1, cols - textWidth(right) - 4));
  const gap = Math.max(1, cols - 2 - textWidth(left) - textWidth(right) - 1);
  out.push(renderParts([[SGR.head, ` ${left}${" ".repeat(gap)}${right} `]], cols, SGR.head));

  // Sidebar rows
  const sideRows: string[] = [];
  if (sideW > 0) {
    const start = sidebarStart(vm.sidebar, bodyH);
    for (let r = 0; r < bodyH; r++) {
      const item = vm.sidebar[start + r];
      if (!item) {
        sideRows.push(" ".repeat(sideW));
        continue;
      }
      if (item.kind === "heading") {
        sideRows.push(renderParts([[SGR.dim, ` ${item.label.toUpperCase()}`]], sideW));
      } else if (item.kind === "note") {
        sideRows.push(renderParts([[SGR.dim, `  ${item.label}`]], sideW));
      } else if (item.kind === "team") {
        sideRows.push(renderParts([[SGR.bold, ` ${ellipsize(item.label, sideW - 2)}`]], sideW));
      } else {
        // Unread conversations get a dot on the right; the name keeps the rest.
        const labelW = sideW - 2 - (item.unread ? 3 : 0);
        const label = ellipsize(item.label, labelW);
        const dot: Part[] = item.unread ? [[item.selected ? SGR.sel : SGR.info, " \u25cf"]] : [];
        sideRows.push(
          item.selected
            ? renderParts([[SGR.sel, `  ${padRight(label, labelW)}`], ...dot], sideW, SGR.sel)
            : renderParts(
                [[item.unread ? SGR.bold : "", `  ${padRight(label, labelW)}`], ...dot],
                sideW
              )
        );
        if (item.key) {
          hits.push({
            x1: 1,
            y1: bodyTop + r,
            x2: sideW,
            y2: bodyTop + r,
            action: { type: "select", key: item.key },
          });
        }
      }
    }
  }

  // Conversation
  const convW = paneW - 2;
  const all = convLines(vm, convW);
  const maxScroll = Math.max(0, all.length - bodyH);
  const scroll = Math.max(0, Math.min(vm.scroll, maxScroll));
  const shown: Array<ConvLine | null> = [];
  const first = Math.max(0, all.length - bodyH - scroll);
  const slice = all.slice(first, first + bodyH);
  for (let i = 0; i < bodyH - slice.length; i++) shown.push(null);
  for (const l of slice) shown.push(l);
  const placements: Placement[] = [];
  const convRows: string[] = [];
  shown.forEach((line, r) => {
    const y = bodyTop + r;
    if (!line) {
      convRows.push(" ".repeat(paneW));
      return;
    }
    if (line.hit) hits.push({ x1: paneX, y1: y, x2: cols, y2: y, action: line.hit });
    convRows.push(renderParts([["", " "], ...line.parts], paneW));
    if (line.image) {
      // Draw only when every row of the image is on screen.
      const rowsLeft = shown.length - r;
      if (line.image.rows <= rowsLeft) {
        placements.push({
          id: line.image.id,
          row: y,
          col: paneX + 3,
          cols: line.image.cols,
          rows: line.image.rows,
          b64: line.image.b64,
          name: line.image.name,
        });
      }
    }
  });
  if (vm.convNote && vm.messages.length === 0) {
    const kind =
      vm.convNote.kind === "error" ? SGR.err : vm.convNote.kind === "ok" ? SGR.ok : SGR.dim;
    const noteLines = wrap(vm.convNote.text, convW - 2);
    noteLines.forEach((l, i) => {
      if (i < bodyH) convRows[i] = renderParts([[kind, `  ${l}`]], paneW);
    });
  }

  for (let r = 0; r < bodyH; r++) {
    const divider = renderParts([[SGR.dim, "│"]], 1);
    out.push(sideW > 0 ? `${sideRows[r]}${divider}${convRows[r]}` : convRows[r]);
  }

  // Footer: notice, attachments, input, keys
  const note = vm.notice;
  const noteSgr = note?.kind === "error" ? SGR.err : note?.kind === "ok" ? SGR.ok : SGR.info;
  out.push(
    note
      ? renderParts([[noteSgr, ` ${note.text}`]], cols)
      : renderParts([[SGR.dim, vm.typing ? ` ${vm.typing}` : ` ${vm.convTitle}`]], cols)
  );

  const chipParts: Part[] = [];
  let chipX = 2;
  if (vm.pending.length === 0) {
    chipParts.push([
      SGR.dim,
      " Ctrl+V pastes an image or file. Click Attach to add what you copied.",
    ]);
  } else {
    chipParts.push(["", " "]);
    vm.pending.forEach((p, index) => {
      const label = `${p.image ? "▣" : "◆"} ${ellipsize(p.name, 22)} ${p.size} `;
      const x = chipX;
      chipParts.push([SGR.chip, label], [SGR.err, "×"], ["", " "]);
      const closeX = x + textWidth(label);
      hits.push({
        x1: closeX,
        y1: rows - 2,
        x2: closeX,
        y2: rows - 2,
        action: { type: "unattach", index },
      });
      chipX = closeX + 2;
    });
  }
  out.push(renderParts(chipParts, cols));

  const attachLabel = " Attach ";
  const sendLabel = " Send ";
  const buttonsW = textWidth(attachLabel) + 1 + textWidth(sendLabel) + 1;
  const inputW = Math.max(4, cols - 3 - buttonsW);
  const shownInput = vm.input.replace(/\n/g, "↵");
  const caretCol = textWidth(shownInput.slice(0, vm.cursor));
  const startCol = Math.max(0, caretCol - inputW + 1);
  let visible = "";
  let skipped = 0;
  for (const ch of shownInput) {
    if (skipped < startCol) {
      skipped += textWidth(ch);
      continue;
    }
    visible += ch;
  }
  const inputRow = rows - 1;
  const attachX = 3 + inputW + 1;
  out.push(
    renderParts(
      [
        [SGR.cyan, " ›"],
        ["", ` ${padRight(visible, inputW)}`],
        [SGR.button, attachLabel],
        ["", " "],
        [SGR.button, sendLabel],
      ],
      cols
    )
  );
  hits.push({
    x1: attachX,
    y1: inputRow,
    x2: attachX + textWidth(attachLabel) - 1,
    y2: inputRow,
    action: { type: "attach" },
  });
  const sendX = attachX + textWidth(attachLabel) + 1;
  hits.push({
    x1: sendX,
    y1: inputRow,
    x2: sendX + textWidth(sendLabel) - 1,
    y2: inputRow,
    action: { type: "send" },
  });

  out.push(
    renderParts(
      [[SGR.dim, " Enter send · Ctrl+J new line · Ctrl+V paste image/file · ↑↓ switch · Esc quit"]],
      cols
    )
  );

  return {
    rows: out,
    hits,
    images: placements,
    cursor: { x: 4 + Math.min(caretCol - startCol, inputW), y: inputRow },
    pane: { x1: paneX, y1: bodyTop, x2: cols, y2: bodyBottom },
    maxScroll,
  };
}

/** The action under a 1-based screen position, if any. */
export function hitAt(frame: Frame, x: number, y: number): Action | null {
  for (let i = frame.hits.length - 1; i >= 0; i--) {
    const h = frame.hits[i];
    if (x >= h.x1 && x <= h.x2 && y >= h.y1 && y <= h.y2) return h.action;
  }
  return null;
}
