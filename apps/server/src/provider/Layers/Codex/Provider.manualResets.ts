import type { ServerProviderManualResets } from "@bigbud/contracts/server/usageLimits.ts";

/** Ignores malformed supplementary grants without losing valid account quota windows. */
export function normalizeCodexManualResets(value: unknown): ServerProviderManualResets | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const credits = value as Record<string, unknown>;
  const count = credits.availableCount;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return undefined;
  const availableExpiries: (string | null)[] = [];
  let complete = Array.isArray(credits.credits);
  const ids = new Set<string>();
  for (const raw of Array.isArray(credits.credits) ? credits.credits : []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      complete = false;
      continue;
    }
    const credit = raw as Record<string, unknown>;
    if (credit.status !== "available" || credit.resetType !== "codexRateLimits") continue;
    if (typeof credit.id !== "string" || !credit.id || ids.has(credit.id)) {
      complete = false;
      continue;
    }
    ids.add(credit.id);
    if (credit.expiresAt === null) availableExpiries.push(null);
    else if (
      typeof credit.expiresAt === "number" &&
      Number.isFinite(credit.expiresAt) &&
      credit.expiresAt >= 0
    ) {
      const date = new Date(credit.expiresAt * 1000);
      if (Number.isFinite(date.getTime())) availableExpiries.push(date.toISOString());
      else complete = false;
    } else complete = false;
  }
  // A capped response can contain fewer grants than the total. Never invent the rest.
  if (availableExpiries.length > count)
    return { availableCount: count, availableExpiries: [], detailsComplete: false };
  return {
    availableCount: count,
    availableExpiries: availableExpiries.toSorted((a, b) =>
      a === b ? 0 : a === null ? 1 : b === null ? -1 : a.localeCompare(b),
    ),
    detailsComplete: complete && availableExpiries.length === count,
  };
}
