import { useLocalStorage } from "./useLocalStorage";
import {
  RecentModelUsage,
  type RecentModelUsage as RecentModelUsageType,
} from "../models/recentlyUsedModels";
import * as Schema from "effect/Schema";

const STORAGE_KEY = "bigbud:recently-used-models:v1";
const EMPTY: RecentModelUsageType[] = [];
const RecentModelsList = Schema.Array(RecentModelUsage);

export function useRecentlyUsedModels(): readonly RecentModelUsageType[] {
  const [value] = useLocalStorage(STORAGE_KEY, EMPTY, RecentModelsList);
  return value;
}
