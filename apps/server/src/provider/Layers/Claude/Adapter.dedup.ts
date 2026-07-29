/** Adds one identity once and evicts the oldest values above the fixed bound. */
export function rememberBoundedIdentity(seen: Set<string>, value: string, limit: number): boolean {
  if (seen.has(value)) return false;
  seen.add(value);
  while (seen.size > limit) {
    const oldest = seen.values().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
  return true;
}
