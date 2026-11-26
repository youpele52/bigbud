/** Compare browser URLs while preserving differences in paths, queries, and fragments. */
export function matchesBrowserUrl(actual: string | undefined, expected: string): boolean {
  if (!actual || !expected) return false;
  try {
    return new URL(actual).toString() === new URL(expected).toString();
  } catch {
    return actual === expected;
  }
}
