import { ProviderKind } from "@bigbud/contracts";
import * as Schema from "effect/Schema";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";

const STORAGE_KEY = "bigbud:recently-used-models:v1";
const LOCAL_STORAGE_CHANGE_EVENT = "bigbud:local_storage_change";
export const MAX_RECENT_MODELS_PER_PROVIDER = 5;

export const RecentModelUsage = Schema.Struct({
  provider: ProviderKind,
  model: Schema.String,
  subProviderID: Schema.optionalKey(Schema.String),
  lastUsedAt: Schema.String,
});
export type RecentModelUsage = typeof RecentModelUsage.Type;

export const RecentModelsRawList = Schema.Array(Schema.Unknown);
const RecentModelsList = Schema.Array(RecentModelUsage);

export function sanitizeRecentModelUsage(entry: RecentModelUsage): RecentModelUsage {
  // Strip subProviderID for providers that don't support it.
  // This fixes legacy localStorage data that may have stored it.
  if (entry.provider !== "opencode" && entry.provider !== "kilocode" && entry.provider !== "pi") {
    const { subProviderID: _discarded, ...rest } = entry;
    return rest;
  }
  return entry;
}

export function normalizeRecentlyUsedModels(entries: ReadonlyArray<unknown>): {
  readonly entries: RecentModelUsage[];
  readonly changed: boolean;
} {
  let changed = false;
  const normalized: RecentModelUsage[] = [];

  for (const entry of entries) {
    if (!Schema.is(RecentModelUsage)(entry)) {
      changed = true;
      continue;
    }
    const sanitized = sanitizeRecentModelUsage(entry);
    if (sanitized !== entry) {
      changed = true;
    }
    normalized.push(sanitized);
  }

  return { entries: normalized, changed };
}

function readAll(): RecentModelUsage[] {
  const result = getLocalStorageItem(STORAGE_KEY, RecentModelsRawList);
  if (!result) return [];
  const normalized = normalizeRecentlyUsedModels(result);
  if (normalized.changed) {
    writeAll(normalized.entries);
  }
  return normalized.entries;
}

function writeAll(list: RecentModelUsage[]): void {
  setLocalStorageItem(STORAGE_KEY, list, RecentModelsList);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(LOCAL_STORAGE_CHANGE_EVENT, { detail: { key: STORAGE_KEY } }),
    );
  }
}

function matchesEntry(
  entry: RecentModelUsage,
  provider: ProviderKind,
  model: string,
  subProviderID: string | undefined,
): boolean {
  return (
    entry.provider === provider &&
    entry.model === model &&
    (entry.subProviderID ?? undefined) === (subProviderID ?? undefined)
  );
}

export function recordModelUsage(
  provider: ProviderKind,
  model: string,
  subProviderID?: string,
): void {
  const supportsSubProvider =
    provider === "opencode" || provider === "kilocode" || provider === "pi";
  const normalizedSubProviderID = supportsSubProvider ? (subProviderID ?? undefined) : undefined;
  const existing = readAll();
  const filtered = existing.filter(
    (entry) => !matchesEntry(entry, provider, model, normalizedSubProviderID),
  );
  const updated: RecentModelUsage = {
    provider,
    model,
    ...(normalizedSubProviderID !== undefined ? { subProviderID: normalizedSubProviderID } : {}),
    lastUsedAt: new Date().toISOString(),
  };
  const merged = [updated, ...filtered];
  const trimmed = trimToLimitPerProvider(merged, MAX_RECENT_MODELS_PER_PROVIDER);
  writeAll(trimmed);
}

export function getRecentlyUsedModels(provider: ProviderKind): RecentModelUsage[] {
  return readAll()
    .filter((entry) => entry.provider === provider)
    .toSorted((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
    .slice(0, MAX_RECENT_MODELS_PER_PROVIDER);
}

function trimToLimitPerProvider(list: RecentModelUsage[], limit: number): RecentModelUsage[] {
  const counts = new Map<ProviderKind, number>();
  const result: RecentModelUsage[] = [];
  for (const entry of list) {
    const count = counts.get(entry.provider) ?? 0;
    if (count < limit) {
      result.push(entry);
      counts.set(entry.provider, count + 1);
    }
  }
  return result;
}

export function clearRecentModels(): void {
  writeAll([]);
}
