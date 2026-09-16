import type { EffortOption } from "@bigbud/contracts";

import type { EffortCacheEntry, EffortCacheFile } from "./effortCache.types.ts";
import { EFFORT_CAPABILITY_CACHE_VERSION } from "./effortCache.types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeEffortOption(value: unknown): EffortOption | null {
  if (!isRecord(value) || typeof value.value !== "string" || typeof value.label !== "string") {
    return null;
  }
  const optionValue = value.value.trim();
  const label = value.label.trim();
  if (!optionValue || !label) return null;
  return {
    value: optionValue,
    label,
    ...(value.isDefault === true ? { isDefault: true } : {}),
  };
}

function decodeEntry(value: unknown): EffortCacheEntry | null {
  if (!isRecord(value)) return null;
  if (value.status !== "verified-supported" && value.status !== "verified-unsupported") {
    return null;
  }
  if (!Array.isArray(value.levels) || typeof value.verifiedAt !== "string") return null;
  if (typeof value.generation !== "number" || !Number.isFinite(value.generation)) return null;
  const levels = value.levels.flatMap((entry) => {
    const option = decodeEffortOption(entry);
    return option ? [option] : [];
  });
  if (value.status === "verified-unsupported" && levels.length > 0) return null;
  if (value.status === "verified-supported" && levels.length === 0) return null;
  return {
    status: value.status,
    levels,
    verifiedAt: value.verifiedAt,
    generation: Math.max(0, Math.trunc(value.generation)),
  };
}

export function decodeEffortCacheFile(value: unknown): EffortCacheFile | null {
  if (!isRecord(value) || value.version !== EFFORT_CAPABILITY_CACHE_VERSION) return null;
  if (!isRecord(value.entries)) return null;
  const entries: Record<string, EffortCacheEntry> = {};
  for (const [key, entry] of Object.entries(value.entries)) {
    if (!key.trim()) continue;
    const decoded = decodeEntry(entry);
    if (decoded) entries[key] = decoded;
  }
  return { version: EFFORT_CAPABILITY_CACHE_VERSION, entries };
}

export function evictEffortCacheEntries(
  entries: Record<string, EffortCacheEntry>,
  maxEntries: number,
): Record<string, EffortCacheEntry> {
  const list = Object.entries(entries);
  if (list.length <= maxEntries) return entries;
  const kept = list
    .toSorted((left, right) => right[1].verifiedAt.localeCompare(left[1].verifiedAt))
    .slice(0, maxEntries);
  return Object.fromEntries(kept);
}
