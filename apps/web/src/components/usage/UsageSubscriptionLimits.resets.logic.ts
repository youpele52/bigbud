/** Keeps identical expiries as individual rows without exposing private reset credit IDs. */
export function limitResetExpiryRows(expiries: ReadonlyArray<string | null>) {
  const occurrences = new Map<string | null, number>();
  return expiries.map((expiry) => {
    const occurrence = (occurrences.get(expiry) ?? 0) + 1;
    occurrences.set(expiry, occurrence);
    return { key: `${expiry ?? "no-expiry"}:${occurrence}`, expiry };
  });
}
