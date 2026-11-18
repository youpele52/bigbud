import { useEffect, useMemo } from "react";
import {
  normalizeRecentlyUsedModels,
  RecentModelsRawList,
  type RecentModelUsage,
  RECENTLY_USED_MODELS_STORAGE_KEY,
  RECENTLY_USED_MODELS_STORAGE_OPTIONS,
} from "../models/recentlyUsedModels";
import { useLocalStorage } from "./useLocalStorage";

const EMPTY: unknown[] = [];

export function useRecentlyUsedModels(): readonly RecentModelUsage[] {
  const [value, setValue] = useLocalStorage(
    RECENTLY_USED_MODELS_STORAGE_KEY,
    EMPTY,
    RecentModelsRawList,
    RECENTLY_USED_MODELS_STORAGE_OPTIONS,
  );
  const normalized = useMemo(() => normalizeRecentlyUsedModels(value), [value]);

  useEffect(() => {
    if (normalized.changed) {
      setValue(normalized.entries);
    }
  }, [normalized.changed, normalized.entries, setValue]);

  return normalized.entries;
}
