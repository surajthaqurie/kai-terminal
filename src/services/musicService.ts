/**
 * Music Time service: turns what the user typed into a YouTube embed.
 * Nothing is stored locally — YouTube owns search, playlists and playback.
 * - YouTube video link (watch / youtu.be / music.youtube.com / shorts / live)
 *   -> direct embed; a `list=` in the link makes it a playlist embed.
 * - Playlist link -> playlist embed.
 * - Plain text -> YouTube search embed (no API key needed):
 *   `https://www.youtube.com/embed?listType=search&list=<query>`
 */

export interface MusicTrack {
  title: string;
  videoId: string | null;
  playlistId: string | null;
  query: string;
}

/** Key of the queue older versions persisted; removed on first run. */
const LEGACY_QUEUE_KEY = "kai_music_queue_v1";

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

/** Extract a playlist id from any YouTube link carrying `list=`. */
export function extractPlaylistId(input: string): string | null {
  if (!isYouTubeUrl(input)) return null;
  const m = input.match(/[?&]list=([\w-]{10,64})/);
  return m ? m[1] : null;
}

export function isYouTubeUrl(input: string): boolean {
  const s = input.trim().toLowerCase();
  return s.includes("youtube.com/") || s.includes("youtu.be/") || s.includes("music.youtube.com");
}

/** Resolve user input into a playable track (link -> direct, text -> search). */
export function resolveInputToTrack(input: string): MusicTrack | null {
  const raw = input.trim().slice(0, 300);
  if (!raw) return null;
  const videoId = extractVideoId(raw);
  const playlistId = extractPlaylistId(raw);
  if (videoId || playlistId) {
    return {
      title: videoId && !playlistId ? "YouTube video" : "YouTube playlist",
      videoId,
      playlistId,
      query: raw,
    };
  }
  if (isYouTubeUrl(raw)) return null; // unparseable link
  return { title: raw.slice(0, 80), videoId: null, playlistId: null, query: raw };
}

/** True when YouTube can move to a next item (playlist or search results). */
export function hasNextItem(track: MusicTrack | null): boolean {
  return Boolean(track && (track.playlistId || !track.videoId));
}

/** Embed src for a track. `muted` only applies at load; later changes use commands. */
export function embedSrcForTrack(track: MusicTrack, muted = false): string {
  const originParam =
    typeof window !== "undefined" && window.location?.origin
      ? `&origin=${encodeURIComponent(window.location.origin)}`
      : "";
  const tail = `autoplay=1&rel=0&enablejsapi=1${originParam}${muted ? "&mute=1" : ""}`;
  if (track.videoId) {
    const list = track.playlistId ? `&list=${track.playlistId}` : "";
    return `https://www.youtube.com/embed/${track.videoId}?${tail}${list}`;
  }
  if (track.playlistId) {
    return `https://www.youtube.com/embed?listType=playlist&list=${track.playlistId}&${tail}`;
  }
  return `https://www.youtube.com/embed?listType=search&list=${encodeURIComponent(track.query)}&${tail}`;
}

/**
 * Searches YouTube for a query string and extracts the first videoId.
 * Resolving search text to a direct videoId prevents Error 153 caused by deprecated listType=search.
 */
export async function searchYouTubeVideoId(query: string): Promise<string | null> {
  const raw = query.trim();
  if (!raw) return null;
  const existingId = extractVideoId(raw);
  if (existingId) return existingId;
  try {
    const res = await fetch(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(raw)}`
    );
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/"videoId":"([\w-]{11})"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Link that opens this track on youtube.com. Only the exact shapes the backend
 * allow-list accepts (`watch?v=`, `playlist?list=`, `results?search_query=`),
 * with search words reduced to letters, marks and digits joined by `+`.
 */
export function watchUrlForTrack(track: MusicTrack): string {
  if (track.videoId) return `https://www.youtube.com/watch?v=${track.videoId}`;
  if (track.playlistId) return `https://www.youtube.com/playlist?list=${track.playlistId}`;
  const words = track.query
    .replace(/[^\p{L}\p{M}\p{N}._~-]+/gu, "+")
    .replace(/^\++|\++$/g, "")
    .slice(0, 200)
    .replace(/\++$/, "");
  return `https://www.youtube.com/results?search_query=${words || "music"}`;
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

export type YouTubeCommand = "playVideo" | "pauseVideo" | "nextVideo" | "mute" | "unMute";

/** Control message for an embed that was loaded with `enablejsapi=1`. */
export function youtubeCommand(func: YouTubeCommand): string {
  return JSON.stringify({ event: "command", func, args: "" });
}

export interface YouTubePlayerTelemetry {
  currentTime?: number;
  duration?: number;
  /** -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued */
  playerState?: number;
  /** Title YouTube reports for the current video. */
  title?: string;
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
    const videoData = i.videoData;
    if (videoData && typeof videoData === "object") {
      const title = (videoData as Record<string, unknown>).title;
      if (typeof title === "string" && title.trim()) out.title = title.trim().slice(0, 80);
    }
    return Object.keys(out).length > 0 ? out : null;
  }
  return null;
}

/** Whole-number playback percentage (0-100); 0 when the duration is unknown. */
export function progressPercent(currentTime: number, duration: number): number {
  if (!(duration > 0) || !(currentTime > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((currentTime / duration) * 100)));
}

/** Remove the queue older versions saved locally; the player keeps nothing now. */
export function clearLegacyQueue(): void {
  try {
    localStorage.removeItem(LEGACY_QUEUE_KEY);
  } catch {
    // storage unavailable: nothing to clean
  }
}
