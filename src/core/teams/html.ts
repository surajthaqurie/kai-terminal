/**
 * Turn the HTML Microsoft Teams stores for a message into terminal text, and
 * build the HTML for a message Kai sends.
 *
 * Everything that reaches the screen goes through `sanitize`: a message is
 * text written by someone else, and a terminal obeys escape sequences, so ESC
 * and every other control character is removed before display.
 */

/** Control characters (C0, DEL, C1) and bidi overrides, written as escapes so no invisible character sits in the source. */
const CONTROL_CHARS = new RegExp(
  "[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]",
  "g"
);

/** Remove control characters and bidi overrides; tabs become spaces, newlines stay. */
export function sanitize(text: string): string {
  return text.replace(/\t/g, " ").replace(CONTROL_CHARS, "");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function attr(tag: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? "") : "";
}

export interface ParsedBody {
  text: string;
  images: Array<{ url: string; alt: string }>;
}

/** A message body as plain text plus the images embedded in it. */
export function parseBody(content: string, isHtml: boolean): ParsedBody {
  if (!isHtml) return { text: sanitize(content).trim(), images: [] };
  const images: ParsedBody["images"] = [];
  let s = content;
  // Emoji arrive as tiny images or custom elements with the character in `alt`.
  s = s.replace(/<emoji\b[^>]*>(?:\s*<\/emoji>)?/gi, (tag) => decodeEntities(attr(tag, "alt")));
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const alt = decodeEntities(attr(tag, "alt"));
    if (/schema\.skype\.com\/Emoji/i.test(tag)) return alt;
    const src = decodeEntities(attr(tag, "src"));
    if (src) images.push({ url: src, alt });
    return "";
  });
  s = s.replace(/<at\b[^>]*>([\s\S]*?)<\/at>/gi, (_m, name: string) => `@${name}`);
  s = s.replace(/<attachment\b[^>]*>\s*<\/attachment>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "• ");
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, "\n");
  s = s.replace(/<[^>]*>/g, "");
  s = sanitize(decodeEntities(s));
  s = s
    .split("\n")
    .map((l) => l.replace(/\s+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: s, images };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * HTML for an outgoing message: the text with line breaks, then one inline
 * image per hosted content (`temporaryId` 1..n, as Graph expects), then links
 * to uploaded files.
 */
export function composeHtml(
  text: string,
  imageCount: number,
  links: ReadonlyArray<{ name: string; url: string }> = []
): string {
  const parts: string[] = [];
  const body = text.trim();
  if (body) parts.push(`<div>${escapeHtml(body).replace(/\r?\n/g, "<br>")}</div>`);
  for (let i = 1; i <= imageCount; i++) {
    parts.push(`<div><img src="../hostedContents/${i}/$value" alt="image ${i}"></div>`);
  }
  for (const l of links) {
    parts.push(`<div><a href="${escapeHtml(l.url)}">${escapeHtml(l.name)}</a></div>`);
  }
  return parts.join("");
}
