/** A released view stays mounted at least this long, so quick switches never rebuild xterm. */
export const TERMINAL_VIEW_PARK_DELAY_MS = 30_000;
/** The most recently attached surfaces (thread drawers and panels) whose views stay warm. */
export const TERMINAL_VIEW_WARM_SURFACES = 4;
/** Hard cap on warm xterm instances across the warm surfaces (plan §13). */
export const TERMINAL_VIEW_WARM_MAX_VIEWS = 12;

export type TerminalViewState = "attached" | "warm" | "parked";

export interface TerminalViewPolicyEntry {
  readonly key: string;
  /** Views of one surface stay warm or go cold together. */
  readonly surfaceKey: string;
  readonly attached: boolean;
  /** False once parked: the xterm instance is disposed and only the host restores it. */
  readonly mounted: boolean;
  /** Only a view the host can restore exactly may ever be parked. */
  readonly restorable: boolean;
  readonly lastAttachedAt: number;
  /** When the last borrower released the view; null while attached or never attached. */
  readonly releasedAt: number | null;
}

/**
 * Keys of views that stay warm: views of the most recently attached surfaces, newest first,
 * never more than the view cap. Attached views always count, even beyond the cap.
 */
export function selectWarmTerminalViews(
  entries: ReadonlyArray<TerminalViewPolicyEntry>,
): Set<string> {
  const mounted = entries.filter((entry) => entry.mounted);
  const surfaceRecency = new Map<string, number>();
  for (const entry of mounted) {
    const recency = entry.attached ? Number.POSITIVE_INFINITY : entry.lastAttachedAt;
    surfaceRecency.set(
      entry.surfaceKey,
      Math.max(surfaceRecency.get(entry.surfaceKey) ?? 0, recency),
    );
  }
  const warmSurfaces = new Set(
    [...surfaceRecency.entries()]
      .toSorted((left, right) => right[1] - left[1])
      .slice(0, TERMINAL_VIEW_WARM_SURFACES)
      .map(([surfaceKey]) => surfaceKey),
  );
  const warm = new Set<string>();
  for (const entry of mounted) if (entry.attached) warm.add(entry.key);
  const candidates = mounted
    .filter((entry) => !entry.attached && warmSurfaces.has(entry.surfaceKey))
    .toSorted((left, right) => right.lastAttachedAt - left.lastAttachedAt);
  for (const entry of candidates) {
    if (warm.size >= TERMINAL_VIEW_WARM_MAX_VIEWS) break;
    warm.add(entry.key);
  }
  return warm;
}

/**
 * Hard memory cap: with more mounted views than the warm cap, the least recently used released
 * views that cannot be parked (not restorable) are disposed at once. They replay server history
 * on the next acquire, as the old 10-drawer cap did. Attached views are never chosen; restorable
 * ones follow the park policy instead.
 */
export function selectTerminalViewsToEvict(
  entries: ReadonlyArray<TerminalViewPolicyEntry>,
): string[] {
  const mounted = entries.filter((entry) => entry.mounted);
  const excess = mounted.length - TERMINAL_VIEW_WARM_MAX_VIEWS;
  if (excess <= 0) return [];
  return mounted
    .filter((entry) => !entry.attached && !entry.restorable)
    .toSorted((left, right) => left.lastAttachedAt - right.lastAttachedAt)
    .slice(0, excess)
    .map((entry) => entry.key);
}

function parkableAt(entry: TerminalViewPolicyEntry): number | null {
  if (!entry.mounted || entry.attached || !entry.restorable || entry.releasedAt === null)
    return null;
  return entry.releasedAt + TERMINAL_VIEW_PARK_DELAY_MS;
}

/** Views to unmount now: released long enough, restorable, and outside the warm set. */
export function selectTerminalViewsToPark(
  entries: ReadonlyArray<TerminalViewPolicyEntry>,
  now: number,
): string[] {
  const warm = selectWarmTerminalViews(entries);
  return entries
    .filter((entry) => {
      const at = parkableAt(entry);
      return at !== null && at <= now && !warm.has(entry.key);
    })
    .map((entry) => entry.key);
}

/**
 * When the next park check is due, or null when nothing could ever park without a new event
 * (attach, release, restorable change). Warm views are re-checked when their delay lapses
 * because a later attach can push them out of the warm set without touching them.
 */
export function nextTerminalViewParkCheck(
  entries: ReadonlyArray<TerminalViewPolicyEntry>,
  now: number,
): number | null {
  let next: number | null = null;
  for (const entry of entries) {
    const at = parkableAt(entry);
    if (at === null || at <= now) continue;
    next = next === null ? at : Math.min(next, at);
  }
  return next;
}

export function terminalViewState(entry: TerminalViewPolicyEntry): TerminalViewState {
  if (!entry.mounted) return "parked";
  return entry.attached ? "attached" : "warm";
}
