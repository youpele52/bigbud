export type ProviderTaskRevision = number | string;

/** Provider-neutral ordering metadata for reconciling task patches across event sources. */
export interface TaskFreshness {
  /** Stable identity for one provider session/stream epoch. */
  readonly sessionEpoch?: string | undefined;
  readonly sourcePriority: number;
  readonly snapshotGeneration?: number | undefined;
  readonly providerRevision?: ProviderTaskRevision | undefined;
  readonly providerMessageId?: string | undefined;
  /** Provider-supplied event time, when the provider exposes one. */
  readonly providerTimestamp?: string | undefined;
  /** Monotonic only within `sessionEpoch`; it is the final ordering tie-breaker. */
  readonly observedOrdinal: number;
}

function compareOptionalNumber(left: number | undefined, right: number | undefined): number {
  if (left === right) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  return left < right ? -1 : 1;
}

function compareOptionalString(left: string | undefined, right: string | undefined): number {
  if (left === right) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  return left < right ? -1 : 1;
}

function compareRevision(
  left: ProviderTaskRevision | undefined,
  right: ProviderTaskRevision | undefined,
): number {
  if (left === right) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  if (typeof left === "number" && typeof right === "number") {
    return left < right ? -1 : 1;
  }
  return String(left) < String(right) ? -1 : 1;
}

/**
 * Returns a negative number when `left` is older than `right`.
 *
 * Native revisions identify the provider's order when available. Snapshot generation
 * then orders authoritative replacements, source priority resolves otherwise-equal
 * sources, and an ordinal is intentionally considered only inside one stream epoch.
 * This makes a reconnect deterministic without letting a reset local counter replay
 * over a prior epoch.
 */
export function compareTaskFreshness(left: TaskFreshness, right: TaskFreshness): number {
  const stableOrder =
    compareOptionalString(left.sessionEpoch, right.sessionEpoch) ||
    compareRevision(left.providerRevision, right.providerRevision) ||
    compareOptionalString(left.providerTimestamp, right.providerTimestamp) ||
    compareOptionalNumber(left.observedOrdinal, right.observedOrdinal) ||
    compareOptionalNumber(left.snapshotGeneration, right.snapshotGeneration) ||
    compareOptionalNumber(left.sourcePriority, right.sourcePriority) ||
    compareOptionalString(left.providerMessageId, right.providerMessageId);
  return stableOrder;
}

export function isTaskFreshnessNewer(candidate: TaskFreshness, existing: TaskFreshness): boolean {
  return compareTaskFreshness(candidate, existing) > 0;
}

/** Stable display order shared by live reducers, projectors, and cold snapshots. */
export function compareTaskOrder(
  left: {
    readonly id: string;
    readonly order?: number | undefined;
    readonly freshness: TaskFreshness;
  },
  right: {
    readonly id: string;
    readonly order?: number | undefined;
    readonly freshness: TaskFreshness;
  },
): number {
  return (
    compareOptionalNumber(left.order, right.order) ||
    compareTaskFreshness(left.freshness, right.freshness) ||
    left.id.localeCompare(right.id)
  );
}

export type TaskPatch<T extends object> = {
  readonly [K in keyof T]?: T[K] | null | undefined;
};

type MergedTaskPatch<T extends object, P extends TaskPatch<T>> = Omit<T, keyof P> & {
  readonly [K in keyof P]-?: Exclude<P[K], undefined>;
};

/** Merges a patch while treating `undefined` as omitted and `null` as an explicit clear. */
export function mergeTaskPatch<T extends object, P extends TaskPatch<T>>(
  base: T,
  patch: P,
): MergedTaskPatch<T, P> {
  const result = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) result[key] = value;
  }
  return result as MergedTaskPatch<T, P>;
}

export interface BoundedDisplayOptions {
  readonly maxChars?: number;
  readonly maxEntries?: number;
  readonly maxDepth?: number;
}

const DEFAULT_MAX_CHARS = 1_000;
const DEFAULT_MAX_ENTRIES = 20;
const DEFAULT_MAX_DEPTH = 4;
const REDACTED = "[redacted]";
const TRUNCATED = "…";

function redactSensitiveText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s)\]}>,]+/giu, "[redacted-url]")
    .replace(/\b(?:sk|pk|rk)_[a-z0-9_-]{8,}\b/giu, REDACTED)
    .replace(/\bbearer\s+[^\s,;]+/giu, REDACTED)
    .replace(/\b(?:token|api[_-]?key|secret|password)\s*[:=]\s*[^\s,;]+/giu, REDACTED);
}

function isSensitiveDisplayKey(key: string): boolean {
  return /(?:api[_-]?key|token|secret|password|authorization)/iu.test(key);
}

/** Redacts common secret/URL forms, then bounds text to a deterministic display limit. */
export function toBoundedRedactedText(value: string, options: BoundedDisplayOptions = {}): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const redacted = redactSensitiveText(value);
  return redacted.length <= maxChars
    ? redacted
    : `${redacted.slice(0, Math.max(0, maxChars - 1))}${TRUNCATED}`;
}

export type BoundedDisplayValue =
  | boolean
  | null
  | number
  | string
  | ReadonlyArray<BoundedDisplayValue>
  | { readonly [key: string]: BoundedDisplayValue };

/** Produces a bounded, redacted structured value suitable for UI display or diagnostics. */
export function toBoundedRedactedDisplayValue(
  value: unknown,
  options: BoundedDisplayOptions = {},
  depth = 0,
): BoundedDisplayValue {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return toBoundedRedactedText(value, options);
  if (depth >= maxDepth) return TRUNCATED;
  if (Array.isArray(value)) {
    return value
      .slice(0, maxEntries)
      .map((entry) => toBoundedRedactedDisplayValue(entry, options, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, maxEntries)
        .map(([key, entry]) => [
          key,
          isSensitiveDisplayKey(key)
            ? REDACTED
            : toBoundedRedactedDisplayValue(entry, options, depth + 1),
        ]),
    );
  }
  return REDACTED;
}
