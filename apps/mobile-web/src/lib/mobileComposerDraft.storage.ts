/** Session-scoped composition never falls back to a different browser storage area. */
export function getMobileComposerDraftStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}
