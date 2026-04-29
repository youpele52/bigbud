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

const RecentModelsList = Schema.Array(RecentModelUsage);

function readAll(): RecentModelUsage[] {
  const result = getLocalStorageItem(STORAGE_KEY, RecentModelsList);
  return result ? [...result] : [];
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
    (entry.subProviderID ?? undefined) === subProviderID
  );
}

export function recordModelUsage(
  provider: ProviderKind,
  model: string,
  subProviderID?: string,
): void {
  const existing = readAll();
  const filtered = existing.filter((entry) => !matchesEntry(entry, provider, model, subProviderID));
  const updated: RecentModelUsage = {
    provider,
    model,
    ...(subProviderID !== undefined ? { subProviderID } : {}),
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
