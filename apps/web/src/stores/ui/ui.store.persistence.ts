import { ThreadId } from "@bigbud/contracts";

import type { PersistedUiState } from "./ui.store.types";

export function sanitizePersistedLastActiveThreadId(value: unknown): ThreadId | null {
  return typeof value === "string" && value.length > 0 && value.trim() === value
    ? ThreadId.makeUnsafe(value)
    : null;
}

export function sanitizePersistedThreadLastVisitedAt(
  value: PersistedUiState["threadLastVisitedAtById"],
): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const nextState: Record<string, string> = {};
  for (const [threadId, visitedAt] of Object.entries(value)) {
    if (!threadId || typeof visitedAt !== "string" || !Number.isFinite(Date.parse(visitedAt))) {
      continue;
    }
    nextState[threadId] = visitedAt;
  }
  return nextState;
}

export function sanitizePersistedThreadChangedFilesExpanded(
  value: PersistedUiState["threadChangedFilesExpandedById"],
): Record<string, Record<string, boolean>> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const nextState: Record<string, Record<string, boolean>> = {};
  for (const [threadId, turns] of Object.entries(value)) {
    if (!threadId || !turns || typeof turns !== "object") {
      continue;
    }

    const nextTurns = Object.fromEntries(
      Object.entries(turns).filter(([turnId, expanded]) => turnId && typeof expanded === "boolean"),
    );
    if (Object.keys(nextTurns).length > 0) {
      nextState[threadId] = nextTurns;
    }
  }
  return nextState;
}
