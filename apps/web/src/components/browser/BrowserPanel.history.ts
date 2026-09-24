import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";

const BROWSER_HISTORY_STORAGE_KEY = "bigbud:browser-history:v2";
const LEGACY_BROWSER_HISTORY_STORAGE_KEY = "bigbud:browser-history:v1";
const BROWSER_HISTORY_VERSION = 2;
const MAX_BROWSER_HISTORY_ITEMS = 20;
const MAX_BROWSER_HISTORY_SUGGESTIONS = 5;
const browserDataListeners = new Set<() => void>();

function emitBrowserDataChange(): void {
  for (const listener of browserDataListeners) listener();
}

export function subscribeBrowserData(listener: () => void): () => void {
  browserDataListeners.add(listener);
  const handleStorage = (event: StorageEvent) => {
    if (
      event.key === BROWSER_HISTORY_STORAGE_KEY ||
      event.key === LEGACY_BROWSER_HISTORY_STORAGE_KEY
    ) {
      listener();
    }
  };
  if (typeof window !== "undefined") window.addEventListener("storage", handleStorage);
  return () => {
    browserDataListeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", handleStorage);
  };
}

export interface BrowserVisitRecord {
  readonly normalizedUrl: string;
  readonly title: string;
  readonly origin: string;
  readonly visitedAt: string;
  readonly visitCount: number;
}

function normalizeBrowserUrl(url: string): { normalizedUrl: string; origin: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    return { normalizedUrl: parsed.toString(), origin: parsed.origin };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is BrowserVisitRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.normalizedUrl === "string" &&
    typeof record.title === "string" &&
    typeof record.origin === "string" &&
    typeof record.visitedAt === "string" &&
    typeof record.visitCount === "number"
  );
}

function sanitizeVisit(record: BrowserVisitRecord): BrowserVisitRecord | null {
  const normalized = normalizeBrowserUrl(record.normalizedUrl);
  if (!normalized || !Number.isFinite(record.visitCount) || record.visitCount < 1) return null;
  return {
    normalizedUrl: normalized.normalizedUrl,
    origin: normalized.origin,
    title: record.title.trim(),
    visitedAt: record.visitedAt,
    visitCount: Math.floor(record.visitCount),
  };
}

export function migrateBrowserHistory(
  raw: unknown,
  now = new Date().toISOString(),
): BrowserVisitRecord[] {
  const values = Array.isArray(raw)
    ? raw
    : raw &&
        typeof raw === "object" &&
        (raw as { version?: unknown }).version === BROWSER_HISTORY_VERSION
      ? (raw as { visits?: unknown }).visits
      : [];
  if (!Array.isArray(values)) return [];

  const visits: BrowserVisitRecord[] = [];
  for (const value of values) {
    const record =
      typeof value === "string"
        ? (() => {
            const normalized = normalizeBrowserUrl(value);
            return normalized ? { ...normalized, title: "", visitedAt: now, visitCount: 1 } : null;
          })()
        : isRecord(value)
          ? sanitizeVisit(value)
          : null;
    if (!record || visits.some((visit) => visit.normalizedUrl === record.normalizedUrl)) continue;
    visits.push(record);
  }
  return visits
    .toSorted((left, right) => right.visitedAt.localeCompare(left.visitedAt))
    .slice(0, MAX_BROWSER_HISTORY_ITEMS);
}

function readBrowserHistory(): BrowserVisitRecord[] {
  const raw = getLocalStorageItem(BROWSER_HISTORY_STORAGE_KEY, Schema.Unknown, {
    legacyKeys: [LEGACY_BROWSER_HISTORY_STORAGE_KEY],
  });
  if (!raw) return [];
  const visits = migrateBrowserHistory(raw);
  if (!Array.isArray(raw) && (raw as { version?: unknown }).version === BROWSER_HISTORY_VERSION)
    return visits;
  writeBrowserHistory(visits);
  return visits;
}

function writeBrowserHistory(visits: BrowserVisitRecord[]): void {
  setLocalStorageItem(
    BROWSER_HISTORY_STORAGE_KEY,
    { version: BROWSER_HISTORY_VERSION, visits },
    Schema.Unknown,
    { legacyKeys: [LEGACY_BROWSER_HISTORY_STORAGE_KEY] },
  );
  emitBrowserDataChange();
}

export function getBrowserHistory(): BrowserVisitRecord[] {
  return readBrowserHistory();
}

export function resolveNextBrowserHistory(
  history: BrowserVisitRecord[],
  input: { url: string; title: string; visitedAt?: string },
): BrowserVisitRecord[] {
  const normalized = normalizeBrowserUrl(input.url);
  if (!normalized) return history;
  const existing = history.find((visit) => visit.normalizedUrl === normalized.normalizedUrl);
  const next: BrowserVisitRecord = {
    ...normalized,
    title: input.title.trim() || existing?.title || "",
    visitedAt: input.visitedAt ?? new Date().toISOString(),
    visitCount: (existing?.visitCount ?? 0) + 1,
  };
  return [next, ...history.filter((visit) => visit.normalizedUrl !== next.normalizedUrl)].slice(
    0,
    MAX_BROWSER_HISTORY_ITEMS,
  );
}

export function filterBrowserHistory(history: BrowserVisitRecord[], query: string): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  return history
    .filter(
      (visit) =>
        !normalizedQuery ||
        visit.normalizedUrl.toLowerCase().includes(normalizedQuery) ||
        visit.title.toLowerCase().includes(normalizedQuery),
    )
    .slice(0, normalizedQuery ? MAX_BROWSER_HISTORY_SUGGESTIONS : MAX_BROWSER_HISTORY_ITEMS)
    .map((visit) => visit.normalizedUrl);
}

export function resolveBrowserHistorySelectionIndex(
  currentIndex: number,
  direction: number,
  suggestionCount: number,
): number {
  if (suggestionCount <= 0) return -1;
  if (currentIndex < 0) return direction === 1 ? 0 : suggestionCount - 1;
  return (currentIndex + direction + suggestionCount) % suggestionCount;
}

export function recordBrowserHistoryVisit(input: {
  url: string;
  title: string;
}): BrowserVisitRecord[] {
  const updated = resolveNextBrowserHistory(readBrowserHistory(), input);
  writeBrowserHistory(updated);
  return updated;
}

export function updateBrowserHistoryVisitTitle(url: string, title: string): BrowserVisitRecord[] {
  const normalized = normalizeBrowserUrl(url);
  const history = readBrowserHistory();
  if (!normalized || !title.trim()) return history;
  const index = history.findIndex((visit) => visit.normalizedUrl === normalized.normalizedUrl);
  if (index < 0) return history;
  const existing = history[index];
  if (!existing) return history;
  const updated = [...history];
  updated[index] = { ...existing, title: title.trim() };
  writeBrowserHistory(updated);
  return updated;
}
