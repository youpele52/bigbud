export const SAVED_CONFIRMATION_MS = 25_000;

/** Only acknowledged writes receive the temporary green confirmation. */
export function isRecentFileSave(savedAt: number | null, now: number): boolean {
  return savedAt !== null && now - savedAt < SAVED_CONFIRMATION_MS;
}
