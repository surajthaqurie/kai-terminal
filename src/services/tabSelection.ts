/**
 * The tab to bring to the front when `closedId` is closed, given the tabs as they were BEFORE it
 * was removed: the tab that takes its place (the one that was to its right), or, when the closed
 * tab was the last, the new last tab. Closing a tab used to jump to the last tab when the close
 * button was used, and to the left neighbour when the shell exited (FUNC-03); both now use this.
 * `undefined` when no other tab remains.
 */
export function tabAfterClose(
  tabs: ReadonlyArray<{ id: string }>,
  closedId: string
): string | undefined {
  const index = tabs.findIndex((t) => t.id === closedId);
  const remaining = tabs.filter((t) => t.id !== closedId);
  if (remaining.length === 0) return undefined;
  if (index < 0) return remaining[remaining.length - 1].id;
  return remaining[Math.min(index, remaining.length - 1)].id;
}
