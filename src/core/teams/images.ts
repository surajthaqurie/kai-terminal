/**
 * Recognise an image from its first bytes (never from a file name) and read
 * its size, so the chat can tell what to attach and how many rows to reserve
 * when drawing it inline.
 */
export type ImageKind = "png" | "jpeg" | "gif" | "webp";

export interface ImageInfo {
  kind: ImageKind;
  width: number;
  height: number;
  mime: string;
}

const MIME: Record<ImageKind, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const EXT: Record<ImageKind, string> = { png: "png", jpeg: "jpg", gif: "gif", webp: "webp" };

export function extensionFor(kind: ImageKind): string {
  return EXT[kind];
}

const be32 = (b: Uint8Array, o: number) =>
  ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const be16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const le16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const ascii = (b: Uint8Array, o: number, s: string) =>
  b.length >= o + s.length && [...s].every((c, i) => b[o + i] === c.charCodeAt(0));

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    // Start-of-frame markers carry the size (not DHT, JPG, DAC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: be16(b, i + 5), width: be16(b, i + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    i += 2 + be16(b, i + 2);
  }
  return null;
}

/** Image type and size from the leading bytes, or null when it is not a supported image. */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  const b = bytes;
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, "PNG\r\n\x1a\n")) {
    return { kind: "png", width: be32(b, 16), height: be32(b, 20), mime: MIME.png };
  }
  if (b.length >= 10 && (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a"))) {
    return { kind: "gif", width: le16(b, 6), height: le16(b, 8), mime: MIME.gif };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    const s = jpegSize(b);
    return s && s.width > 0 && s.height > 0 ? { kind: "jpeg", ...s, mime: MIME.jpeg } : null;
  }
  if (b.length >= 30 && ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) {
    if (ascii(b, 12, "VP8X")) {
      const width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
      const height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
      return { kind: "webp", width, height, mime: MIME.webp };
    }
    if (ascii(b, 12, "VP8 ")) {
      return {
        kind: "webp",
        width: le16(b, 26) & 0x3fff,
        height: le16(b, 28) & 0x3fff,
        mime: MIME.webp,
      };
    }
    return { kind: "webp", width: 0, height: 0, mime: MIME.webp };
  }
  return null;
}

/**
 * Rows needed to draw an image `cols` cells wide. A terminal cell is about
 * twice as tall as wide; unknown sizes get a square-ish guess. Clamped so one
 * image never fills the screen.
 */
export function rowsForImage(
  info: { width: number; height: number },
  cols: number,
  maxRows: number
): number {
  if (!info.width || !info.height) return Math.min(maxRows, Math.ceil(cols / 3));
  return Math.max(1, Math.min(maxRows, Math.ceil((cols * info.height) / info.width / 2)));
}
