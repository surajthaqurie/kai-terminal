/**
 * Music Time service: turns what the user typed into a YouTube embed.
 * Nothing is stored locally — YouTube owns search, playlists and playback.
 * - YouTube video link (watch / youtu.be / music.youtube.com / shorts / live)
 *   -> direct embed; a `list=` in the link makes it a playlist embed.
 * - Playlist link -> playlist embed.
 * - Plain text -> NOT embedded. YouTube retired the `listType=search` embed
 *   (it now renders Error 153) and resolving text to a videoId needs a
 *   server-side search API call: scraping `youtube.com/results` from the
 *   WebView is blocked by CORS and, when it accidentally succeeds, the
 *   first `"videoId"` in the HTML is unrelated to the query (a random
 *   video). Plain text therefore stays a browser-search action instead of
 *   a guessed embed.
 */

export interface MusicTrack {
  title: string;
  videoId: string | null;
  playlistId: string | null;
  query: string;
  thumbnail?: string | null;
}

/** Key of the queue older versions persisted; removed on first run. */
const LEGACY_QUEUE_KEY = "kai_music_queue_v1";

/** Extract an 11-char YouTube videoId from watch / short / live / share URLs. */
function extractVideoId(input: string): string | null {
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

function isYouTubeUrl(input: string): boolean {
  const s = input.trim().toLowerCase();
  return s.includes("youtube.com/") || s.includes("youtu.be/") || s.includes("music.youtube.com");
}

export interface MusicPreset {
  id: string;
  title: string;
  videoId: string;
}

const CURATED_PRESETS: MusicPreset[] = [
  { id: "lofi-girl", title: "Lofi Hip Hop Radio", videoId: "jfKfPfyJRdk" },
  { id: "synthwave", title: "Synthwave Radio", videoId: "4xDzrJKXOOY" },
  { id: "chillhop", title: "Chillhop Radio", videoId: "5yx6BWlEVcY" },
  { id: "coding-focus", title: "Deep Focus Beats", videoId: "0w80F8FffQ4" },
];

function getRandomPreset(): MusicTrack {
  const item = CURATED_PRESETS[Math.floor(Math.random() * CURATED_PRESETS.length)];
  return {
    title: item.title,
    videoId: item.videoId,
    playlistId: null,
    query: item.videoId,
    thumbnail: `https://i.ytimg.com/vi/${encodeURIComponent(item.videoId)}/mqdefault.jpg`,
  };
}

/** Resolve user input into a playable track (link -> direct, text -> search). */
export function resolveInputToTrack(input: string): MusicTrack | null {
  const raw = input.trim().slice(0, 300);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (
    lower === "random" ||
    lower === "random video" ||
    lower === "random music" ||
    lower === "random song"
  ) {
    return getRandomPreset();
  }
  const videoId = extractVideoId(raw);
  const playlistId = extractPlaylistId(raw);
  if (videoId || playlistId) {
    return {
      title: videoId && !playlistId ? "YouTube video" : "YouTube playlist",
      videoId,
      playlistId,
      query: raw,
      thumbnail: videoId
        ? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`
        : null,
    };
  }
  if (isYouTubeUrl(raw)) return null; // unparseable link
  return { title: raw.slice(0, 80), videoId: null, playlistId: null, query: raw };
}

/** True when YouTube can move to a next item (playlists only). */
export function hasNextItem(track: MusicTrack | null): boolean {
  return Boolean(track?.playlistId);
}

/**
 * Embed src for a track, or null when there is nothing embeddable.
 * `muted` and `loop` only apply at load; later changes use commands.
 * `startSeconds` resumes playback at that position on a rebuild (loop-off).
 * Query-only tracks (plain song names) return null: the deprecated
 * `listType=search` embed renders Error 153, so callers must offer the
 * browser-search fallback instead of embedding a guess.
 */
export function embedSrcForTrack(
  track: MusicTrack,
  muted = false,
  loop = false,
  startSeconds = 0
): string | null {
  // Only pass `origin` if it is a standard web HTTP/HTTPS origin (e.g. dev server).
  // In desktop webviews (Tauri), `window.location.origin` is `tauri://localhost` or `tauri://`,
  // which causes YouTube's embed configuration validator to crash with Error 153.
  const isWebOrigin =
    typeof window !== "undefined" &&
    window.location?.origin &&
    /^https?:\/\/(?!tauri)/i.test(window.location.origin);

  const originParam = isWebOrigin
    ? `&origin=${encodeURIComponent(window.location.origin)}`
    : `&widget_referrer=${encodeURIComponent("https://www.youtube-nocookie.com")}`;

  const loopParam = loop && track.videoId ? `&loop=1&playlist=${track.videoId}` : "";
  const startParam = startSeconds > 0 ? `&start=${Math.max(0, Math.floor(startSeconds))}` : "";
  const tail = `autoplay=1&rel=0&controls=0&enablejsapi=1${originParam}${muted ? "&mute=1" : ""}${loopParam}${startParam}`;
  if (track.videoId) {
    const list = track.playlistId ? `&list=${track.playlistId}` : "";
    return `https://www.youtube-nocookie.com/embed/${track.videoId}?${tail}${list}`;
  }
  if (track.playlistId) {
    return `https://www.youtube-nocookie.com/embed?listType=playlist&list=${track.playlistId}&${tail}`;
  }
  return null;
}

export interface YouTubeVideoResult {
  videoId: string;
  title: string;
}

/**
 * Searches YouTube for a query string via backend Tauri invoke (avoiding WebView CORS)
 * with automatic fallback to dev-server proxy in browser environment.
 * Returns up to `limit` items with videoId and title.
 */
export async function searchYouTubeVideos(query: string, limit = 8): Promise<YouTubeVideoResult[]> {
  const raw = query.trim();
  if (!raw) return [];
  const existingId = extractVideoId(raw);
  if (existingId) {
    return [{ videoId: existingId, title: "YouTube Video" }];
  }
  try {
    const { isTauriAvailable } = await import("./ptyService");
    if (isTauriAvailable()) {
      const { invoke } = await import("@tauri-apps/api/core");
      const list = await invoke<{ video_id: string; title: string }[]>(
        "search_youtube_videos_cmd",
        { query: raw, limit }
      );
      if (Array.isArray(list) && list.length > 0) {
        return list
          .filter((item) => item?.video_id && /^[\w-]{11}$/.test(item.video_id))
          .map((item) => ({
            videoId: item.video_id,
            title: item.title,
          }));
      }
    }
  } catch {
    // Backend search failed or Tauri unavailable
  }

  // Fallback for browser / dev-server environment (via Vite dev server middleware)
  try {
    if (typeof fetch !== "undefined") {
      const res = await fetch(`/api/youtube-search?q=${encodeURIComponent(raw)}`);
      if (res.ok) {
        const list = (await res.json()) as { videoId: string; title: string }[];
        if (Array.isArray(list) && list.length > 0) {
          return list
            .filter((item) => item?.videoId && /^[\w-]{11}$/.test(item.videoId))
            .slice(0, limit);
        }
      }
    }
  } catch {
    // ignore
  }

  return [];
}

/**
 * Fetches the ordered song list of a YouTube playlist (videoId + title).
 * Uses the backend Tauri command first (video/ playlist page), falls back to
 * the Vite dev-server middleware when Tauri is not available (browser/dev).
 * Returns [] when the playlist cannot be fetched (private, empty, blocked).
 */
export async function fetchPlaylistVideos(
  playlistId: string,
  limit = 48
): Promise<YouTubeVideoResult[]> {
  const clean = playlistId.trim();
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(clean)) return [];
  const toResults = (rows: { video_id?: string; videoId?: string; title?: string }[]) =>
    rows
      .filter((r) => r?.title && (r.video_id ?? r.videoId))
      .map((r) => ({
        videoId: String(r.video_id ?? r.videoId),
        title: r.title as string,
      }))
      .filter((r) => /^[\w-]{11}$/.test(r.videoId))
      .slice(0, limit);

  try {
    const { isTauriAvailable } = await import("./ptyService");
    if (isTauriAvailable()) {
      const { invoke } = await import("@tauri-apps/api/core");
      const list = await invoke<{ video_id: string; title: string }[]>(
        "fetch_youtube_playlist_cmd",
        { playlistId: clean, limit }
      );
      const mapped = toResults(Array.isArray(list) ? list : []);
      if (mapped.length > 0) return mapped;
    }
  } catch {
    // Backend playlist fetch failed or Tauri unavailable
  }

  // Fallback for browser / dev-server environment (Vite dev middleware)
  try {
    if (typeof fetch !== "undefined") {
      const res = await fetch(
        `/api/youtube-playlist?list=${encodeURIComponent(clean)}&limit=${limit}`
      );
      if (res.ok) {
        const mapped = toResults((await res.json()) as { videoId: string; title: string }[]);
        if (mapped.length > 0) return mapped;
      }
    }
  } catch {
    // ignore
  }
  return [];
}

/**
 * Searches YouTube for a query string via backend Tauri invoke (avoiding WebView CORS).
 * Returns the 11-char videoId or null if search failed/unavailable.
 */
export async function searchYouTubeVideoId(query: string): Promise<string | null> {
  const raw = query.trim();
  if (!raw) return null;
  const existingId = extractVideoId(raw);
  if (existingId) return existingId;
  const results = await searchYouTubeVideos(raw, 1);
  return results[0]?.videoId ?? null;
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

/** Only messages from trusted YouTube origins are accepted as player telemetry. */
export function isYouTubeEmbedOrigin(origin: string): boolean {
  return origin === "https://www.youtube.com" || origin === "https://www.youtube-nocookie.com";
}

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

export type YouTubeCommand =
  "playVideo" | "pauseVideo" | "nextVideo" | "mute" | "unMute" | "seekTo";

/** Control message for an embed that was loaded with `enablejsapi=1`. */
export function youtubeCommand(func: YouTubeCommand | string, args: unknown = ""): string {
  return JSON.stringify({ event: "command", func, args });
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

/** localStorage key for the player's favorite songs. */
const FAVORITES_KEY = "kai_music_favorites";

/** Favorites kept locally, so the list cannot grow without bound. */
const MAX_FAVORITES = 50;

/** True when a track carries something playable (a video or playlist id). */
function isPlayableTrack(t: unknown): t is MusicTrack {
  if (!t || typeof t !== "object") return false;
  const track = t as Partial<MusicTrack>;
  return (
    typeof track.title === "string" &&
    track.title.trim().length > 0 &&
    (typeof track.videoId === "string" || typeof track.playlistId === "string")
  );
}

function sanitizeFavorite(t: MusicTrack): MusicTrack {
  return {
    title: t.title.trim().slice(0, 200),
    videoId: t.videoId && /^[\w-]{11}$/.test(t.videoId) ? t.videoId : null,
    playlistId: t.playlistId && /^[\w-]{10,64}$/.test(t.playlistId) ? t.playlistId : null,
    query: typeof t.query === "string" ? t.query.slice(0, 300) : t.title,
    thumbnail: typeof t.thumbnail === "string" ? t.thumbnail.slice(0, 512) : null,
  };
}

/** Favorites persisted in localStorage (bounded, oldest dropped first). */
export function loadFavorites(): MusicTrack[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isPlayableTrack)
      .map(sanitizeFavorite)
      .filter((t) => t.videoId || t.playlistId)
      .slice(-MAX_FAVORITES);
  } catch {
    return [];
  }
}

export function saveFavorites(list: MusicTrack[]): void {
  try {
    const bounded = list.filter((t) => t.videoId || t.playlistId).slice(-MAX_FAVORITES);
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(bounded));
  } catch {
    // storage unavailable: favorites stay session-only
  }
}

/** Two tracks are "the same song" by video id (falling back to playlist id). */
export function sameTrackIdentity(a: MusicTrack, b: MusicTrack): boolean {
  if (a.videoId && b.videoId) return a.videoId === b.videoId;
  if (a.playlistId && b.playlistId) return a.playlistId === b.playlistId;
  return false;
}

/** Is `track` already in the favorites list? */
export function isFavoriteTrack(track: MusicTrack, favorites: MusicTrack[]): boolean {
  return favorites.some((f) => sameTrackIdentity(f, track));
}

/** Pure toggle: returns a new favorites list with the track added or removed. */
export function toggleFavoriteTrack(track: MusicTrack, favorites: MusicTrack[]): MusicTrack[] {
  if (isFavoriteTrack(track, favorites)) {
    return favorites.filter((f) => !sameTrackIdentity(f, track));
  }
  return [...favorites, sanitizeFavorite(track)].slice(-MAX_FAVORITES);
}
