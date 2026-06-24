import type { ThreadId } from "@bigbud/contracts";

const STORAGE_KEY = "bigbud:mobile-thread-last-visited";

function readVisitMap(): Record<string, string> {
  if (typeof window === "undefined") {
    return {};
  }
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function markThreadVisited(threadId: ThreadId, visitedAt = new Date().toISOString()) {
  if (typeof window === "undefined") {
    return;
  }
  const next = readVisitMap();
  next[threadId] = visitedAt;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function getThreadLastVisitedAt(threadId: ThreadId): string | undefined {
  return readVisitMap()[threadId];
}
