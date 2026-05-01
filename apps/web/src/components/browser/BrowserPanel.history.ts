import * as Schema from "effect/Schema";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";

const BROWSER_HISTORY_STORAGE_KEY = "bigbud:browser-history:v1";
const MAX_BROWSER_HISTORY_ITEMS = 10;
const MAX_BROWSER_HISTORY_SUGGESTIONS = 5;

const BrowserHistoryList = Schema.Array(Schema.String);

function readBrowserHistory(): string[] {
  return [...(getLocalStorageItem(BROWSER_HISTORY_STORAGE_KEY, BrowserHistoryList) ?? [])];
}

function writeBrowserHistory(history: string[]): void {
  setLocalStorageItem(BROWSER_HISTORY_STORAGE_KEY, history, BrowserHistoryList);
}

export function getBrowserHistory(): string[] {
  return readBrowserHistory();
}

export function resolveNextBrowserHistory(history: string[], url: string): string[] {
  const normalizedUrl = url.trim();
  if (!normalizedUrl) return history;
  return [
    normalizedUrl,
    ...history.filter((entry) => entry.toLowerCase() !== normalizedUrl.toLowerCase()),
  ].slice(0, MAX_BROWSER_HISTORY_ITEMS);
}

export function filterBrowserHistory(history: string[], query: string): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return history.slice(0, MAX_BROWSER_HISTORY_ITEMS);
  return history
    .filter((url) => url.toLowerCase().includes(normalizedQuery))
    .slice(0, MAX_BROWSER_HISTORY_SUGGESTIONS);
}

export function resolveBrowserHistorySelectionIndex(
  currentIndex: number,
  direction: 1 | -1,
  suggestionCount: number,
): number {
  if (suggestionCount <= 0) return -1;
  if (currentIndex < 0) return direction === 1 ? 0 : suggestionCount - 1;
  return (currentIndex + direction + suggestionCount) % suggestionCount;
}

export function recordBrowserHistoryUrl(url: string): string[] {
  const existing = readBrowserHistory();
  const updated = resolveNextBrowserHistory(existing, url);
  writeBrowserHistory(updated);
  return updated;
}
