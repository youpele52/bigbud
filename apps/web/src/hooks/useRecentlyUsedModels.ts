import { useMemo } from "react";
import {
  normalizeRecentlyUsedModels,
  RecentModelsRawList,
  type RecentModelUsage,
} from "../models/recentlyUsedModels";
import { useLocalStorage } from "./useLocalStorage";

const STORAGE_KEY = "bigbud:recently-used-models:v1";
const EMPTY: unknown[] = [];

export function useRecentlyUsedModels(): readonly RecentModelUsage[] {
  const [value] = useLocalStorage(STORAGE_KEY, EMPTY, RecentModelsRawList);
  return useMemo(() => normalizeRecentlyUsedModels(value).entries, [value]);
}
