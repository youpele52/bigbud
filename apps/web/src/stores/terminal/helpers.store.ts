import { normalizeTerminalSplitLayout } from "../../lib/terminalSplitLayout";
/**
 * Pure state helpers for the terminal Zustand store.
 *
 * All functions here are stateless transformations on ThreadTerminalState and
 * related types. They are intentionally kept separate from the store creation
 * to keep each file focused and testable in isolation.
 */

import { ThreadId, type TerminalEvent } from "@bigbud/contracts";
import { DEFAULT_THREAD_TERMINAL_HEIGHT, type ThreadTerminalGroup } from "../../models/types";

// ---------------------------------------------------------------------------
// Re-exported types (consumed by the store and by callers)
// ---------------------------------------------------------------------------

export interface ThreadTerminalState {
  terminalOpen: boolean;
  terminalHeight: number;
  terminalIds: string[];
  runningTerminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  /**
   * Panes loaded from storage rather than opened in this page session (`paneOrigin: "restored"`).
   * They only reattach (`attachOnly`) and are dropped when the first inventory lacks them.
   */
  restoredTerminalIds?: string[];
}

/** Where a pane came from: opened by the user now, or loaded from storage. */
export type TerminalPaneOrigin = "user-created" | "restored";

export interface ThreadTerminalLaunchContext {
  cwd: string;
  worktreePath: string | null;
}

export interface TerminalEventEntry {
  id: number;
  event: TerminalEvent;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

export const EMPTY_TERMINAL_EVENT_ENTRIES: ReadonlyArray<TerminalEventEntry> = [];
export const MAX_TERMINAL_EVENT_BUFFER = 200;

// ---------------------------------------------------------------------------
// Helpers: terminal-id normalisation
// ---------------------------------------------------------------------------

export function normalizeTerminalIds(terminalIds: string[]): string[] {
  // No implicit terminal: an empty list stays empty.
  return [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
}

export function normalizeRunningTerminalIds(
  runningTerminalIds: string[],
  terminalIds: string[],
): string[] {
  if (runningTerminalIds.length === 0) return [];
  const validTerminalIdSet = new Set(terminalIds);
  return [...new Set(runningTerminalIds)]
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && validTerminalIdSet.has(id));
}

export function isValidTerminalId(terminalId: string): boolean {
  return terminalId.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Helpers: terminal-group management
// ---------------------------------------------------------------------------

export function fallbackGroupId(terminalId: string): string {
  return `group-${terminalId}`;
}

export function assignUniqueGroupId(baseId: string, usedGroupIds: Set<string>): string {
  let candidate = baseId;
  let index = 2;
  while (usedGroupIds.has(candidate)) {
    candidate = `${baseId}-${index}`;
    index += 1;
  }
  usedGroupIds.add(candidate);
  return candidate;
}

export function findGroupIndexByTerminalId(
  terminalGroups: ThreadTerminalGroup[],
  terminalId: string,
): number {
  return terminalGroups.findIndex((group) => group.terminalIds.includes(terminalId));
}

function normalizeTerminalGroupIds(terminalIds: string[]): string[] {
  return [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
}

export function normalizeTerminalGroups(
  terminalGroups: ThreadTerminalGroup[],
  terminalIds: string[],
): ThreadTerminalGroup[] {
  const validTerminalIdSet = new Set(terminalIds);
  const assignedTerminalIds = new Set<string>();
  const nextGroups: ThreadTerminalGroup[] = [];
  const usedGroupIds = new Set<string>();

  for (const group of terminalGroups) {
    const groupTerminalIds = normalizeTerminalGroupIds(group.terminalIds).filter((terminalId) => {
      if (!validTerminalIdSet.has(terminalId)) return false;
      if (assignedTerminalIds.has(terminalId)) return false;
      return true;
    });
    if (groupTerminalIds.length === 0) continue;
    for (const terminalId of groupTerminalIds) {
      assignedTerminalIds.add(terminalId);
    }
    const baseGroupId =
      group.id.trim().length > 0 ? group.id.trim() : fallbackGroupId(groupTerminalIds[0] ?? "");
    nextGroups.push({
      id: assignUniqueGroupId(baseGroupId, usedGroupIds),
      terminalIds: groupTerminalIds,
      ...(group.layout
        ? { layout: normalizeTerminalSplitLayout(group.layout, groupTerminalIds) }
        : {}),
    });
  }

  for (const terminalId of terminalIds) {
    if (assignedTerminalIds.has(terminalId)) continue;
    nextGroups.push({
      id: assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds),
      terminalIds: [terminalId],
    });
  }

  return nextGroups;
}

export function copyTerminalGroups(groups: ThreadTerminalGroup[]): ThreadTerminalGroup[] {
  return groups.map((group) => ({
    ...group,
    terminalIds: [...group.terminalIds],
  }));
}

// ---------------------------------------------------------------------------
// Helpers: equality
// ---------------------------------------------------------------------------

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function terminalGroupsEqual(left: ThreadTerminalGroup[], right: ThreadTerminalGroup[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftGroup = left[index];
    const rightGroup = right[index];
    if (!leftGroup || !rightGroup) return false;
    if (leftGroup.id !== rightGroup.id) return false;
    if (JSON.stringify(leftGroup.layout) !== JSON.stringify(rightGroup.layout)) return false;
    if (!arraysEqual(leftGroup.terminalIds, rightGroup.terminalIds)) return false;
  }
  return true;
}

export function threadTerminalStateEqual(
  left: ThreadTerminalState,
  right: ThreadTerminalState,
): boolean {
  return (
    left.terminalOpen === right.terminalOpen &&
    left.terminalHeight === right.terminalHeight &&
    left.activeTerminalId === right.activeTerminalId &&
    left.activeTerminalGroupId === right.activeTerminalGroupId &&
    arraysEqual(left.terminalIds, right.terminalIds) &&
    arraysEqual(left.runningTerminalIds, right.runningTerminalIds) &&
    arraysEqual(left.restoredTerminalIds ?? [], right.restoredTerminalIds ?? []) &&
    terminalGroupsEqual(left.terminalGroups, right.terminalGroups)
  );
}

// ---------------------------------------------------------------------------
// Default state
// ---------------------------------------------------------------------------

/** A thread has no terminal until the user opens one (plan D1). */
export const DEFAULT_THREAD_TERMINAL_STATE: ThreadTerminalState = Object.freeze({
  terminalOpen: false,
  terminalHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
  terminalIds: [],
  runningTerminalIds: [],
  activeTerminalId: "",
  terminalGroups: [],
  activeTerminalGroupId: "",
});

export function createDefaultThreadTerminalState(): ThreadTerminalState {
  return {
    ...DEFAULT_THREAD_TERMINAL_STATE,
    terminalIds: [...DEFAULT_THREAD_TERMINAL_STATE.terminalIds],
    runningTerminalIds: [...DEFAULT_THREAD_TERMINAL_STATE.runningTerminalIds],
    terminalGroups: copyTerminalGroups(DEFAULT_THREAD_TERMINAL_STATE.terminalGroups),
  };
}

export function createSingleThreadTerminalState(terminalId: string): ThreadTerminalState {
  if (!isValidTerminalId(terminalId)) return createDefaultThreadTerminalState();
  const normalizedTerminalId = terminalId.trim();
  return {
    terminalOpen: true,
    terminalHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalIds: [normalizedTerminalId],
    runningTerminalIds: [],
    activeTerminalId: normalizedTerminalId,
    terminalGroups: [
      {
        id: fallbackGroupId(normalizedTerminalId),
        terminalIds: [normalizedTerminalId],
      },
    ],
    activeTerminalGroupId: fallbackGroupId(normalizedTerminalId),
  };
}

export function getDefaultThreadTerminalState(): ThreadTerminalState {
  return DEFAULT_THREAD_TERMINAL_STATE;
}

// ---------------------------------------------------------------------------
// State normalisation
// ---------------------------------------------------------------------------

export function normalizeThreadTerminalState(state: ThreadTerminalState): ThreadTerminalState {
  const nextTerminalIds = normalizeTerminalIds(state.terminalIds);
  const runningTerminalIds = normalizeRunningTerminalIds(state.runningTerminalIds, nextTerminalIds);
  const restoredTerminalIds = normalizeRunningTerminalIds(
    state.restoredTerminalIds ?? [],
    nextTerminalIds,
  );
  const activeTerminalId = nextTerminalIds.includes(state.activeTerminalId)
    ? state.activeTerminalId
    : (nextTerminalIds[0] ?? "");
  const terminalGroups = normalizeTerminalGroups(state.terminalGroups, nextTerminalIds);
  const activeGroupIdFromState = terminalGroups.some(
    (group) => group.id === state.activeTerminalGroupId,
  )
    ? state.activeTerminalGroupId
    : null;
  const activeGroupIdFromTerminal =
    terminalGroups.find((group) => group.terminalIds.includes(activeTerminalId))?.id ?? null;

  const normalized: ThreadTerminalState = {
    // An empty surface cannot be open: closing the last pane closes the surface.
    terminalOpen: state.terminalOpen && nextTerminalIds.length > 0,
    terminalHeight:
      Number.isFinite(state.terminalHeight) && state.terminalHeight > 0
        ? state.terminalHeight
        : DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalIds: nextTerminalIds,
    runningTerminalIds,
    activeTerminalId,
    terminalGroups,
    activeTerminalGroupId:
      activeGroupIdFromState ?? activeGroupIdFromTerminal ?? terminalGroups[0]?.id ?? "",
    ...(restoredTerminalIds.length > 0 ? { restoredTerminalIds } : {}),
  };
  return threadTerminalStateEqual(state, normalized) ? state : normalized;
}

export function isDefaultThreadTerminalState(state: ThreadTerminalState): boolean {
  const normalized = normalizeThreadTerminalState(state);
  return threadTerminalStateEqual(normalized, DEFAULT_THREAD_TERMINAL_STATE);
}

// ---------------------------------------------------------------------------
// Re-exports from split files
// ---------------------------------------------------------------------------

export {
  setThreadTerminalOpen,
  setThreadTerminalHeight,
  upsertTerminalIntoGroups,
  splitThreadTerminal,
  newThreadTerminal,
  setThreadActiveTerminal,
  closeThreadTerminal,
  setThreadTerminalActivity,
} from "./helpers.transitions.store";

export {
  terminalEventBufferKey,
  selectTerminalEventEntries,
  selectTerminalEventLastId,
  appendTerminalEventEntry,
  launchContextFromStartEvent,
} from "./helpers.events.store";

// ---------------------------------------------------------------------------
// Store-level state selectors
// ---------------------------------------------------------------------------

export function selectThreadTerminalState(
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>,
  threadId: ThreadId,
): ThreadTerminalState {
  if (threadId.length === 0) {
    return getDefaultThreadTerminalState();
  }
  return terminalStateByThreadId[threadId] ?? getDefaultThreadTerminalState();
}

export function updateTerminalStateByThreadId(
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>,
  threadId: ThreadId,
  updater: (state: ThreadTerminalState) => ThreadTerminalState,
): Record<ThreadId, ThreadTerminalState> {
  if (threadId.length === 0) {
    return terminalStateByThreadId;
  }

  const current = selectThreadTerminalState(terminalStateByThreadId, threadId);
  const next = updater(current);
  if (next === current) {
    return terminalStateByThreadId;
  }

  if (isDefaultThreadTerminalState(next)) {
    if (terminalStateByThreadId[threadId] === undefined) {
      return terminalStateByThreadId;
    }
    const { [threadId]: _removed, ...rest } = terminalStateByThreadId;
    return rest as Record<ThreadId, ThreadTerminalState>;
  }

  return {
    ...terminalStateByThreadId,
    [threadId]: next,
  };
}

// ---------------------------------------------------------------------------
// Pane selectors shared with the lifecycle UI (W3)
// ---------------------------------------------------------------------------

interface ThreadSurfaceState {
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>;
  panelTerminalStateByThreadId: Record<ThreadId, ThreadTerminalState>;
}

const EMPTY_SURFACE_PANES: readonly string[] = Object.freeze([]);

/**
 * Terminal ids the user has on a thread: drawer panes, then right-panel panes. Empty when the
 * thread has no terminal. A single surface returns its stored array; the union is a new array,
 * so subscribe with `useShallow`.
 */
export function selectThreadSurfacePanes(
  state: ThreadSurfaceState,
  threadId: string,
): readonly string[] {
  if (threadId.length === 0) return EMPTY_SURFACE_PANES;
  const drawer = state.terminalStateByThreadId[threadId as ThreadId]?.terminalIds ?? [];
  const panel = state.panelTerminalStateByThreadId[threadId as ThreadId]?.terminalIds ?? [];
  if (panel.length === 0) return drawer.length > 0 ? drawer : EMPTY_SURFACE_PANES;
  if (drawer.length === 0) return panel;
  return [...new Set([...drawer, ...panel])];
}

export function selectTerminalPaneOrigin(
  state: ThreadSurfaceState,
  threadId: string,
  terminalId: string,
): TerminalPaneOrigin {
  const restored = (surface: Record<ThreadId, ThreadTerminalState>) =>
    surface[threadId as ThreadId]?.restoredTerminalIds?.includes(terminalId) === true;
  return restored(state.terminalStateByThreadId) || restored(state.panelTerminalStateByThreadId)
    ? "restored"
    : "user-created";
}
