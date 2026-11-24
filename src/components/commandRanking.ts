/**
 * Command palette ranking: fuzzy, but predictable. Better matches score higher:
 *   exact label > label prefix > word start in label > substring in label >
 *   subsequence in label (fuzzy) > any match in the category.
 * Ties keep the original action order, so the list never shuffles randomly.
 */

export interface RankableAction {
  id: string;
  label: string;
  category: string;
}

/** Characters of `query` appear in `text` in order. Returns a gap penalty, or -1. */
function subsequence(text: string, query: string): number {
  let at = -1;
  let gaps = 0;
  for (const ch of query) {
    const next = text.indexOf(ch, at + 1);
    if (next < 0) return -1;
    if (at >= 0) gaps += next - at - 1;
    at = next;
  }
  return gaps;
}

function scoreText(text: string, query: string): number {
  const t = text.toLowerCase();
  if (t === query) return 1000;
  if (t.startsWith(query)) return 800;
  if (new RegExp(`(^|[\\s/:(-])${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(t))
    return 600;
  if (t.includes(query)) return 400;
  const gaps = subsequence(t.replace(/\s+/g, " "), query);
  if (gaps >= 0) return Math.max(100, 300 - gaps * 10);
  return 0;
}

/** Score of one action for a query (0 = no match). */
export function scoreAction(action: RankableAction, rawQuery: string): number {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return 1;
  // Every word must match somewhere ("split right" finds "Split Pane Right").
  const words = query.split(/\s+/);
  let total = 0;
  for (const word of words) {
    const label = scoreText(action.label, word);
    const category = scoreText(action.category, word) / 4;
    const best = Math.max(label, category);
    if (best === 0) return 0;
    total += best;
  }
  // A whole-query label match outranks the same words matched separately.
  return total + scoreText(action.label, query) / 2;
}

/** Matching actions, best first; ties keep their original order. */
export function rankActions<T extends RankableAction>(actions: T[], query: string): T[] {
  return actions
    .map((action, index) => ({ action, index, score: scoreAction(action, query) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((r) => r.action);
}

const RECENT_KEY = "kai_palette_recent";
const RECENT_MAX = 5;

/** Ids of the most recently run palette commands, newest first. */
export function loadRecentCommands(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(raw)
      ? raw.filter((v): v is string => typeof v === "string").slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

export function recordRecentCommand(id: string): void {
  try {
    const next = [id, ...loadRecentCommands().filter((r) => r !== id)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage disabled: recents are a convenience only.
  }
}

/**
 * With an empty query, recently used commands come first (in recency order),
 * then everything else in its usual order. Unknown recent ids are skipped.
 */
export function withRecentsFirst<T extends RankableAction>(
  actions: T[],
  recentIds: string[]
): { items: T[]; recentCount: number } {
  const byId = new Map(actions.map((a) => [a.id, a]));
  const recent = recentIds.map((id) => byId.get(id)).filter((a): a is T => Boolean(a));
  const rest = actions.filter((a) => !recent.includes(a));
  return { items: [...recent, ...rest], recentCount: recent.length };
}
