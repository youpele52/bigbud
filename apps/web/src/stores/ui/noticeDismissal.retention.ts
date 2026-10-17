/** Per-store renderer-session cap; evicted presentations may be shown again, never unlocked. */
export const MAX_NOTICE_DISMISSALS = 512;

/** Trim oldest insertion first. Call only on a new collection, after refreshing the written key. */
export function pruneNoticeDismissals<Key>(entries: Map<Key, unknown> | Set<Key>): void {
  while (entries.size > MAX_NOTICE_DISMISSALS) {
    const oldest = entries.keys().next();
    if (oldest.done) return;
    entries.delete(oldest.value);
  }
}
