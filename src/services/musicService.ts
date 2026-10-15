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
    return `https://www.youtube.com/embed/${track.videoId}?autoplay=1&rel=0`;
  }
  return `https://www.youtube.com/embed?listType=search&list=${encodeURIComponent(track.query)}&autoplay=1`;
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
