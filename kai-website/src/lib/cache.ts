/* localStorage cache with TTL. Silent offline fallback — never throws. */

export const CACHE_TTL = 3_600_000;

export function readCache(key: string): string | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { t: number; v: string };
    if (typeof parsed.t !== 'number' || Date.now() - parsed.t > CACHE_TTL) return null;
    return typeof parsed.v === 'string' ? parsed.v : null;
  } catch {
    return null;
  }
}

export function writeCache(key: string, v: string) {
  try {
    localStorage.setItem(key, JSON.stringify({ t: Date.now(), v }));
  } catch {
    /* storage full or blocked — non-fatal */
  }
}
