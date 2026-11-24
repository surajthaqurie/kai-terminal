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
  /**
   * Has messages you have not seen: a number shows how many, `true` (count not
   * known, only that the newest one is unseen) shows a dot.
   */
  unread?: boolean | number;
}

export interface PendingView {
  name: string;
  size: string;
  image: boolean;
}

/** One row of search results. */
export interface SearchResult {
  kind: "person" | "conv" | "message";
  title: string;
  detail: string;
}

export interface SearchView {
  query: string;
  /** Index into `query` (UTF-16 code units). */
  cursor: number;
  results: SearchResult[];
  /** The highlighted result (Enter opens it). */
  selected: number;
  /** Results come from messages already loaded here; said so the user knows the limits. */
  scopeNote?: string;
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
  /** Sidebar rows scrolled down by the mouse wheel; undefined keeps the selected row in view. */
  sidebarScroll?: number;
  /** Search is open: results take the message pane and the box becomes the search field. */
  search?: SearchView | null;
  /** Scroll so this message is in view (a search result was opened). */
  focusId?: string | null;
  /** Draw this message highlighted (just jumped to). */
  highlightId?: string | null;
  /** The words searched for, marked inside the highlighted message. */
  highlightQuery?: string;
  /** Messages that arrived below while scrolled up. */
  newBelow?: number;
  /** All unread messages, for the header. */
  unreadTotal?: number;
}

export type Action =
  | { type: "select"; key: string }
  | { type: "attach" }
  | { type: "send" }
  | { type: "unattach"; index: number }
  | { type: "older" }
  | { type: "open"; messageId: string; kind: "image" | "file"; index: number }
  | { type: "search" }
  | { type: "result"; index: number }
  | { type: "jump" };

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
  /** The sidebar, for wheel scrolling (absent when the window is too narrow for one). */
  sidebarPane?: { x1: number; y1: number; x2: number; y2: number };
  maxSidebarScroll?: number;
  /** The first sidebar row shown. */
  sidebarTop?: number;
  /** The scroll actually used (after clamping, or after moving to `focusId`). */
  scroll?: number;
  /** Conversation lines in all, and the line each message starts on (to keep the reader's place). */
  totalLines?: number;
  msgStart?: Record<string, number>;
  /** Messages with at least one line on screen (their pictures are worth loading). */
  visibleIds?: string[];
}

export const MIN_COLS = 40;
export const MIN_ROWS = 10;
const FOOTER_ROWS = 4;
const MAX_IMAGE_COLS = 44;
const MAX_IMAGE_ROWS = 14;

const SGR = {
  head: "30;46;1",
  headBtn: "30;47",
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
  badge: "97;41;1",
  match: "30;43",
  jump: "30;46;1",
  focus: "33;1",
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
  /** The message this line belongs to. */
  msgId?: string;
  /** Set on the first line of an inline image; its remaining rows follow as blank lines. */
  image?: { id: string; cols: number; rows: number; b64: string; name: string };
  /** Set on every row an inline image covers, so a picture cut off by the edge can say so. */
  imageRow?: { id: string; name: string };
}

function sizeLabel(n: number): string {
  return n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

export function formatSize(bytes: number): string {
  return sizeLabel(bytes);
}

/** The badge text for an unread count: `99+` past 99. */
export function badgeText(n: number): string {
  return n > 99 ? "99+" : String(n);
}

/** What a clickable line says it will do: open here, or open a named site in the browser. */
function openHint(host?: string): string {
  return host ? `  opens ${host} in your browser` : "  click to open";
}

/** Split `text` so every case-insensitive match of `query` gets the match style. */
export function highlightParts(text: string, query: string, base = ""): Part[] {
  const q = query.trim().toLowerCase();
  if (!q) return [[base, text]];
  const lower = text.toLowerCase();
  const parts: Part[] = [];
  let i = 0;
  for (;;) {
    const at = lower.indexOf(q, i);
    if (at < 0) break;
    if (at > i) parts.push([base, text.slice(i, at)]);
    parts.push([SGR.match, text.slice(at, at + q.length)]);
    i = at + q.length;
  }
  if (i < text.length) parts.push([base, text.slice(i)]);
  return parts;
}

function convLines(
  vm: ViewModel,
  width: number
): { lines: ConvLine[]; start: Record<string, number> } {
  const lines: ConvLine[] = [];
  const start: Record<string, number> = {};
  let lastDay = "";
  if (vm.older === "available") {
    lines.push({
      parts: [[SGR.dim, "▲ earlier messages · scroll up, or click here to load them"]],
      hit: { type: "older" },
    });
  } else if (vm.older === "loading") {
    lines.push({ parts: [[SGR.dim, "... loading earlier messages"]] });
  } else if (vm.messages.length > 0) {
    lines.push({ parts: [[SGR.dim, "· beginning of the conversation ·"]] });
  }
  for (const m of vm.messages) {
    if (m.day && m.day !== lastDay) {
      lastDay = m.day;
      const label = ` ${m.day} `;
      const side = Math.max(2, Math.floor((width - 2 - textWidth(label)) / 2));
      lines.push({ parts: [[SGR.dim, `${"─".repeat(side)}${label}${"─".repeat(side)}`]] });
    }
    start[m.id] = lines.length;
    const id = m.id;
    if (m.system) {
      for (const l of wrap(m.text || "(system message)", width - 2)) {
        lines.push({ parts: [[SGR.dim, `  ${l}`]], msgId: id });
      }
      continue;
    }
    const focused = vm.highlightId === m.id;
    const color = m.mine ? SGR.mine : `${nameColor(m.from)};1`;
    lines.push({
      msgId: id,
      parts: [
        ...(focused ? ([[SGR.focus, "▶ "]] as Part[]) : []),
        [SGR.dim, `${m.time} `],
        [focused ? SGR.match : color, m.mine ? "You" : m.from],
        ...(m.pending ? ([[SGR.dim, "  sending..."]] as Part[]) : []),
      ],
    });
    if (m.text) {
      for (const l of wrap(m.text, width - 2)) {
        lines.push({
          msgId: id,
          parts: [["", "  "], ...highlightParts(l, focused ? (vm.highlightQuery ?? "") : "")],
        });
      }
    }
    m.images.forEach((img, index) => {
      const open: Action = { type: "open", messageId: m.id, kind: "image", index };
      if (img.state === "inline" && img.b64) {
        const cols = Math.max(8, Math.min(MAX_IMAGE_COLS, width - 4));
        const rows = rowsForImage(
          { width: img.width ?? 0, height: img.height ?? 0 },
          cols,
          MAX_IMAGE_ROWS
        );
        const imageId = `${m.id}:${index}`;
        const imageRow = { id: imageId, name: img.name || "image" };
        lines.push({
          msgId: id,
          parts: [],
          hit: open,
          image: { id: imageId, cols, rows, b64: img.b64, name: img.name },
          imageRow,
        });
        for (let r = 1; r < rows; r++) lines.push({ msgId: id, parts: [], hit: open, imageRow });
      } else {
        lines.push({
          msgId: id,
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
        msgId: id,
        parts: [
          ["", "  "],
          [SGR.purple, `◆ ${f.name}`],
          [SGR.dim, openHint(f.host)],
        ],
        hit: { type: "open", messageId: m.id, kind: "file", index },
      });
    });
    lines.push({ parts: [], msgId: id });
  }
  return { lines, start };
}

/** Index of the sidebar row to start from so the selected row stays in view. */
function sidebarStart(items: SidebarItem[], height: number): number {
  const sel = items.findIndex((i) => i.selected);
  if (sel < 0 || items.length <= height) return 0;
  return Math.max(0, Math.min(sel - Math.floor(height / 2), items.length - height));
}

function unreadCount(u: SidebarItem["unread"]): number {
  return typeof u === "number" ? u : 0;
}

const RESULT_HEADINGS: Record<SearchResult["kind"], string> = {
  person: "PEOPLE",
  conv: "CHATS AND CHANNELS",
  message: "MESSAGES",
};

/** The search results, drawn in the message pane. */
function searchRows(
  s: SearchView,
  paneX: number,
  paneW: number,
  bodyTop: number,
  bodyH: number,
  hits: Hit[]
): string[] {
  type Row = { parts: Part[]; index?: number };
  const rows: Row[] = [];
  const q = s.query.trim();
  if (!q) {
    rows.push({ parts: [[SGR.bold, " Search"]] });
    rows.push({ parts: [] });
    rows.push({ parts: [[SGR.dim, " Type a name, a chat or channel, or words from a message."]] });
    rows.push({
      parts: [[SGR.dim, " People are found by name in your chats and in messages loaded here."]],
    });
  } else if (s.results.length === 0) {
    rows.push({ parts: [[SGR.bold, ` No results for “${q}”`]] });
    rows.push({ parts: [] });
    rows.push({ parts: [[SGR.dim, " Try part of a name, or fewer words."]] });
  } else {
    rows.push({
      parts: [
        [SGR.bold, ` ${s.results.length} result${s.results.length === 1 ? "" : "s"} for “${q}”`],
      ],
    });
    let kind: SearchResult["kind"] | null = null;
    s.results.forEach((r, index) => {
      if (r.kind !== kind) {
        kind = r.kind;
        rows.push({ parts: [] });
        rows.push({ parts: [[SGR.dim, ` ${RESULT_HEADINGS[r.kind]}`]] });
      }
      const icon = r.kind === "person" ? "● " : r.kind === "conv" ? "# " : "“ ";
      const sel = index === s.selected;
      const titleW = r.kind === "message" ? Math.min(40, Math.floor(paneW * 0.45)) : paneW - 4;
      const title = ellipsize(r.title, titleW);
      // Marker (3) + icon (2) + gap (2) + a cell to spare at the right edge.
      const detailW = Math.max(0, paneW - 8 - textWidth(title));
      const detail = r.detail ? ellipsize(r.detail, detailW) : "";
      rows.push({
        index,
        parts: [
          [sel ? SGR.sel : "", sel ? " ❯ " : "   "],
          [sel ? SGR.sel : SGR.cyan, icon],
          ...highlightParts(title, q, sel ? SGR.sel : SGR.bold),
          [sel ? SGR.sel : "", "  "],
          ...highlightParts(detail, q, sel ? SGR.sel : SGR.dim),
        ],
      });
    });
    if (s.scopeNote) {
      rows.push({ parts: [] });
      for (const l of wrap(s.scopeNote, paneW - 2)) rows.push({ parts: [[SGR.dim, ` ${l}`]] });
    }
  }
  // Keep the selected result on screen.
  const selRow = rows.findIndex((r) => r.index === s.selected);
  let first = 0;
  if (selRow >= bodyH) first = Math.min(selRow - bodyH + 2, rows.length - bodyH);
  const out: string[] = [];
  for (let r = 0; r < bodyH; r++) {
    const row = rows[first + r];
    if (!row) {
      out.push(" ".repeat(paneW));
      continue;
    }
    const sel = row.index !== undefined && row.index === s.selected;
    out.push(renderParts(row.parts, paneW, sel ? SGR.sel : ""));
    if (row.index !== undefined) {
      hits.push({
        x1: paneX,
        y1: bodyTop + r,
        x2: paneX + paneW - 1,
        y2: bodyTop + r,
        action: { type: "result", index: row.index },
      });
    }
  }
  return out;
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

  // Header: where you are, unread count, a Search button, and the sync state.
  const total = vm.unreadTotal ?? 0;
  const searchBtn = vm.search ? " ⌕ Searching " : " ⌕ Search  Ctrl+K ";
  const unreadLabel = total > 0 ? ` ${badgeText(total)} unread ` : "";
  const tail = `  ${vm.headerRight} `;
  const rightW =
    (unreadLabel ? textWidth(unreadLabel) + 1 : 0) + textWidth(searchBtn) + textWidth(tail);
  const leftW = Math.max(1, cols - rightW);
  const headParts: Part[] = [
    [SGR.head, padRight(` ${ellipsize(vm.headerLeft, Math.max(1, leftW - 2))}`, leftW)],
  ];
  if (unreadLabel) headParts.push([SGR.badge, unreadLabel], [SGR.head, " "]);
  const searchX = leftW + (unreadLabel ? textWidth(unreadLabel) + 1 : 0) + 1;
  headParts.push([SGR.headBtn, searchBtn], [SGR.head, tail]);
  out.push(renderParts(headParts, cols, SGR.head));
  if (rightW < cols) {
    hits.push({
      x1: searchX,
      y1: 1,
      x2: searchX + textWidth(searchBtn) - 1,
      y2: 1,
      action: { type: "search" },
    });
  }

  // Sidebar rows
  const sideRows: string[] = [];
  let maxSidebarScroll = 0;
  let sidebarTop = 0;
  if (sideW > 0) {
    maxSidebarScroll = Math.max(0, vm.sidebar.length - bodyH);
    const start =
      vm.sidebarScroll === undefined
        ? sidebarStart(vm.sidebar, bodyH)
        : Math.max(0, Math.min(vm.sidebarScroll, maxSidebarScroll));
    sidebarTop = start;
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
        // Unread conversations get a count (or a dot) on the right; the name keeps the rest.
        const n = unreadCount(item.unread);
        const mark = n > 0 ? ` ${badgeText(n)} ` : item.unread ? " ●" : "";
        const markW = mark ? textWidth(mark) + 1 : 0;
        const labelW = sideW - 2 - markW;
        const label = ellipsize(item.label, labelW);
        const markSgr = n > 0 ? SGR.badge : item.selected ? SGR.sel : SGR.info;
        const markParts: Part[] = mark
          ? [
              [item.selected ? SGR.sel : "", " ".repeat(markW - textWidth(mark))],
              [markSgr, mark],
            ]
          : [];
        sideRows.push(
          item.selected
            ? renderParts([[SGR.sel, `  ${padRight(label, labelW)}`], ...markParts], sideW, SGR.sel)
            : renderParts(
                [[item.unread ? SGR.bold : "", `  ${padRight(label, labelW)}`], ...markParts],
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

  // Conversation (or search results)
  const convW = paneW - 2;
  const { lines: all, start: msgStart } = convLines(vm, convW);
  const maxScroll = Math.max(0, all.length - bodyH);
  let scroll = Math.max(0, Math.min(vm.scroll, maxScroll));
  if (vm.focusId && msgStart[vm.focusId] !== undefined) {
    // Put the message a third of the way down the pane.
    const want = Math.max(0, msgStart[vm.focusId] - Math.floor(bodyH / 3));
    scroll = Math.max(0, Math.min(all.length - bodyH - want, maxScroll));
  }
  const placements: Placement[] = [];
  let convRows: string[] = [];
  const visible = new Set<string>();
  if (vm.search) {
    convRows = searchRows(vm.search, paneX, paneW, bodyTop, bodyH, hits);
  } else {
    const shown: Array<ConvLine | null> = [];
    const first = Math.max(0, all.length - bodyH - scroll);
    const slice = all.slice(first, first + bodyH);
    for (let i = 0; i < bodyH - slice.length; i++) shown.push(null);
    for (const l of slice) shown.push(l);
    const drawn = new Set<string>();
    shown.forEach((line, r) => {
      if (line?.image && line.image.rows <= shown.length - r) drawn.add(line.image.id);
    });
    const placeholdered = new Set<string>();
    shown.forEach((line, r) => {
      const y = bodyTop + r;
      if (!line) {
        convRows.push(" ".repeat(paneW));
        return;
      }
      if (line.msgId) visible.add(line.msgId);
      if (line.hit) hits.push({ x1: paneX, y1: y, x2: cols, y2: y, action: line.hit });
      let parts = line.parts;
      // A picture the edge of the pane cuts off cannot be drawn in part: say what is there.
      if (line.imageRow && !drawn.has(line.imageRow.id) && !placeholdered.has(line.imageRow.id)) {
        placeholdered.add(line.imageRow.id);
        parts = [
          ["", "  "],
          [SGR.purple, `▣ ${line.imageRow.name}`],
          [SGR.dim, "  scroll to see the picture, or click to open it"],
        ];
      }
      convRows.push(renderParts([["", " "], ...parts], paneW));
      if (line.image && drawn.has(line.image.id)) {
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
    });
    if (vm.convNote && vm.messages.length === 0) {
      const kind =
        vm.convNote.kind === "error" ? SGR.err : vm.convNote.kind === "ok" ? SGR.ok : SGR.dim;
      const noteLines = wrap(vm.convNote.text, convW - 2);
      noteLines.forEach((l, i) => {
        if (i < bodyH) convRows[i] = renderParts([[kind, `  ${l}`]], paneW);
      });
    }
    // Scrolled up: a bar to jump back down, saying how many new messages are waiting.
    if (scroll > 0 && bodyH >= 4) {
      const n = vm.newBelow ?? 0;
      const label =
        n > 0
          ? ` ↓ ${n} new message${n === 1 ? "" : "s"} · click or press End `
          : " ↓ Jump to latest · End ";
      const w = Math.min(paneW - 2, textWidth(label));
      const x = Math.max(0, Math.floor((paneW - w) / 2));
      const row = bodyH - 1;
      // An image under the bar would be drawn over it: drop the ones that reach this row.
      for (let i = placements.length - 1; i >= 0; i--) {
        const p = placements[i];
        if (p.row + p.rows - 1 >= bodyTop + row) placements.splice(i, 1);
      }
      convRows[row] = renderParts(
        [
          ["", " ".repeat(x)],
          [n > 0 ? SGR.badge : SGR.jump, ellipsize(label, w)],
        ],
        paneW
      );
      // The bar replaces whatever was on that row, clicks included.
      for (let i = hits.length - 1; i >= 0; i--) {
        const h = hits[i];
        if (h.y1 === bodyTop + row && h.x1 >= paneX) hits.splice(i, 1);
      }
      hits.push({
        x1: paneX + x,
        y1: bodyTop + row,
        x2: paneX + x + w - 1,
        y2: bodyTop + row,
        action: { type: "jump" },
      });
    }
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

  const inputRow = rows - 1;
  if (vm.search) {
    out.push(
      renderParts(
        [
          [
            SGR.dim,
            " Search people, chats, channels and loaded messages. Click a result to open it.",
          ],
        ],
        cols
      )
    );
    const prompt = " ⌕ ";
    const inputW = Math.max(4, cols - textWidth(prompt) - 1);
    const caretCol = textWidth(vm.search.query.slice(0, vm.search.cursor));
    const startCol = Math.max(0, caretCol - inputW + 1);
    const visibleQuery = sliceFromCol(vm.search.query, startCol);
    out.push(
      renderParts(
        [
          [SGR.cyan + ";1", prompt],
          ["", padRight(visibleQuery || "", inputW)],
        ],
        cols
      )
    );
    out.push(
      renderParts([[SGR.dim, " Type to search · ↑↓ choose · Enter open · Esc close"]], cols)
    );
    return finish(
      out,
      hits,
      placements,
      { x: textWidth(prompt) + 1 + Math.min(caretCol - startCol, inputW), y: inputRow },
      { paneX, bodyTop, cols, bodyBottom, sideW, sidebarTop },
      maxScroll,
      maxSidebarScroll,
      scroll,
      all.length,
      msgStart,
      [...visible]
    );
  }

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
  const visibleInput = sliceFromCol(shownInput, startCol);
  const attachX = 3 + inputW + 1;
  out.push(
    renderParts(
      [
        [SGR.cyan, " ›"],
        ["", ` ${padRight(visibleInput, inputW)}`],
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
      [
        [
          SGR.dim,
          " Enter send · Ctrl+J new line · Ctrl+V paste · Ctrl+K search · PgUp/PgDn scroll · ↑↓ switch · Esc quit",
        ],
      ],
      cols
    )
  );

  return finish(
    out,
    hits,
    placements,
    { x: 4 + Math.min(caretCol - startCol, inputW), y: inputRow },
    { paneX, bodyTop, cols, bodyBottom, sideW, sidebarTop },
    maxScroll,
    maxSidebarScroll,
    scroll,
    all.length,
    msgStart,
    [...visible]
  );
}

/** `s` without its first `col` cells. */
function sliceFromCol(s: string, col: number): string {
  let out = "";
  let skipped = 0;
  for (const ch of s) {
    if (skipped < col) {
      skipped += textWidth(ch);
      continue;
    }
    out += ch;
  }
  return out;
}

function finish(
  rows: string[],
  hits: Hit[],
  images: Placement[],
  cursor: { x: number; y: number },
  g: {
    paneX: number;
    bodyTop: number;
    cols: number;
    bodyBottom: number;
    sideW: number;
    sidebarTop: number;
  },
  maxScroll: number,
  maxSidebarScroll: number,
  scroll: number,
  totalLines: number,
  msgStart: Record<string, number>,
  visibleIds: string[]
): Frame {
  return {
    rows,
    hits,
    images,
    cursor,
    pane: { x1: g.paneX, y1: g.bodyTop, x2: g.cols, y2: g.bodyBottom },
    maxScroll,
    ...(g.sideW > 0
      ? {
          sidebarPane: { x1: 1, y1: g.bodyTop, x2: g.sideW, y2: g.bodyBottom },
          maxSidebarScroll,
          sidebarTop: g.sidebarTop,
        }
      : {}),
    scroll,
    totalLines,
    msgStart,
    visibleIds,
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
