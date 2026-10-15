/**
 * YouTube music service: smart search + queue persistence.
 * Single input handles both cases (backend decides):
 * - YouTube URL (watch / youtu.be / music.youtube.com / shorts / live)
 *   -> extracts videoId -> direct embed load.
 * - Plain text -> YouTube search embed (no API key needed):
 *   `https://www.youtube.com/embed?listType=search&list=<query>`
 */

export interface MusicTrack {
  id: string;
  title: string;
  videoId: string | null;
  query: string;
}

const QUEUE_KEY = "kai_music_queue_v1";

function uid(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID().slice(0, 8);
    }
  } catch {
    // ignore
  }
  return Math.floor(Math.random() * 0xffffffff).toString(16);
}

/** Extract an 11-char YouTube videoId from watch / short / live / share URLs. */
export function extractVideoId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const patterns = [
    /[?&]v=([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /youtube\.com\/(shorts|live|embed)\/([\w-]{11})/,
    /music\.youtube\.com\/watch\?[^#]*v=([\w-]{11})/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const cand = m[m.length - 1];
      if (cand && /^[\w-]{11}$/.test(cand)) return cand;
    }
  }
  // Raw 11-char id pasted directly.
  if (/^[\w-]{11}$/.test(s)) return s;
  return null;
}

export function isYouTubeUrl(input: string): boolean {
  const s = input.trim().toLowerCase();
  return s.includes("youtube.com/") || s.includes("youtu.be/") || s.includes("music.youtube.com");
}

/** Resolve user input into a playable track (URL -> direct, text -> search). */
export function resolveInputToTrack(input: string): MusicTrack | null {
  const raw = input.trim().slice(0, 300);
  if (!raw) return null;
  const videoId = extractVideoId(raw);
  if (videoId) {
    return { id: uid(), title: raw.slice(0, 80), videoId, query: raw };
  }
  if (isYouTubeUrl(raw) && !videoId) return null; // unparseable URL
  return { id: uid(), title: raw.slice(0, 80), videoId: null, query: raw };
}

/** Embed src for a track. Search tracks use listType=search (no API key). */
export function embedSrcForTrack(track: MusicTrack): string {
  if (track.videoId) {
    return `https://www.youtube.com/embed/${track.videoId}?autoplay=1&rel=0&enablejsapi=1`;
  }
  return `https://www.youtube.com/embed?listType=search&list=${encodeURIComponent(track.query)}&autoplay=1&enablejsapi=1`;
}

/** Only messages from this origin are trusted as player telemetry. */
export const YOUTUBE_EMBED_ORIGIN = "https://www.youtube.com";

/**
 * Handshake an embed with `enablejsapi=1` waits for before it starts posting
 * `infoDelivery` (currentTime / duration / playerState) messages. This is the
 * same protocol the official IFrame API script uses, without loading remote
 * script (CSP keeps `script-src 'self'`).
 */
export const YOUTUBE_LISTENING_HANDSHAKE = JSON.stringify({
  event: "listening",
  id: 1,
  channel: "widget",
});

export interface YouTubePlayerTelemetry {
  currentTime?: number;
  duration?: number;
  /** -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued */
  playerState?: number;
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Parse a postMessage payload from a YouTube embed. Returns null for anything
 * that is not player telemetry (other origins' payloads, malformed JSON,
 * unrelated events), so callers can ignore it safely.
 */
export function parseYouTubePlayerMessage(data: unknown): YouTubePlayerTelemetry | null {
  if (typeof data !== "string" || data.length > 8192) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const { event, info } = msg as { event?: unknown; info?: unknown };
  if (event === "onStateChange") {
    const playerState = finiteNumber(info);
    return playerState !== undefined ? { playerState } : null;
  }
  if (event === "infoDelivery" && info && typeof info === "object") {
    const i = info as Record<string, unknown>;
    const out: YouTubePlayerTelemetry = {};
    const currentTime = finiteNumber(i.currentTime);
    const duration = finiteNumber(i.duration);
    const playerState = finiteNumber(i.playerState);
    if (currentTime !== undefined) out.currentTime = currentTime;
    if (duration !== undefined) out.duration = duration;
    if (playerState !== undefined) out.playerState = playerState;
    return Object.keys(out).length > 0 ? out : null;
  }
  return null;
}

/** Whole-number playback percentage (0-100); 0 when the duration is unknown. */
export function progressPercent(currentTime: number, duration: number): number {
  if (!(duration > 0) || !(currentTime > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((currentTime / duration) * 100)));
}

export function thumbnailForTrack(track: MusicTrack): string | null {
  if (!track.videoId) return null;
  return `https://i.ytimg.com/vi/${track.videoId}/default.jpg`;
}

export function loadQueue(): MusicTrack[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t) => t && typeof t === "object")
      .slice(0, 50)
      .map((t) => ({
        id: typeof t.id === "string" ? t.id : uid(),
        title: typeof t.title === "string" ? t.title.slice(0, 80) : "Untitled",
        videoId: typeof t.videoId === "string" && /^[\w-]{11}$/.test(t.videoId) ? t.videoId : null,
        query: typeof t.query === "string" ? t.query.slice(0, 300) : "",
      }))
      .filter((t) => t.query || t.videoId);
  } catch {
    return [];
  }
}

export function saveQueue(tracks: MusicTrack[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(tracks.slice(0, 50)));
  } catch {
    // quota ignored
  }
}
