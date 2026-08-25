import type { PersistedUiState } from "./ui.store.types";

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
