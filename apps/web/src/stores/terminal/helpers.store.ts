/**
 * Pure state helpers for the terminal Zustand store.
 *
 * All functions here are stateless transformations on ThreadTerminalState and
 * related types. They are intentionally kept separate from the store creation
 * to keep each file focused and testable in isolation.
 */

import { ThreadId, type TerminalEvent } from "@bigbud/contracts";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  type ThreadTerminalGroup,
} from "../../models/types";

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
}

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
  const ids = [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
  return ids.length > 0 ? ids : [DEFAULT_THREAD_TERMINAL_ID];
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
      group.id.trim().length > 0
        ? group.id.trim()
        : fallbackGroupId(groupTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
    nextGroups.push({
      id: assignUniqueGroupId(baseGroupId, usedGroupIds),
      terminalIds: groupTerminalIds,
    });
  }

  for (const terminalId of terminalIds) {
    if (assignedTerminalIds.has(terminalId)) continue;
    nextGroups.push({
      id: assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds),
      terminalIds: [terminalId],
    });
  }

  if (nextGroups.length === 0) {
    return [
      {
        id: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
      },
    ];
  }

  return nextGroups;
}

export function copyTerminalGroups(groups: ThreadTerminalGroup[]): ThreadTerminalGroup[] {
  return groups.map((group) => ({
    id: group.id,
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
    terminalGroupsEqual(left.terminalGroups, right.terminalGroups)
  );
}

// ---------------------------------------------------------------------------
// Default state
// ---------------------------------------------------------------------------

export const DEFAULT_THREAD_TERMINAL_STATE: ThreadTerminalState = Object.freeze({
  terminalOpen: false,
  terminalHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
  terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
  runningTerminalIds: [],
  activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
  terminalGroups: [
    {
      id: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
      terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
    },
  ],
  activeTerminalGroupId: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
});

export function createDefaultThreadTerminalState(): ThreadTerminalState {
  return {
    ...DEFAULT_THREAD_TERMINAL_STATE,
    terminalIds: [...DEFAULT_THREAD_TERMINAL_STATE.terminalIds],
    runningTerminalIds: [...DEFAULT_THREAD_TERMINAL_STATE.runningTerminalIds],
    terminalGroups: copyTerminalGroups(DEFAULT_THREAD_TERMINAL_STATE.terminalGroups),
  };
}

export function getDefaultThreadTerminalState(): ThreadTerminalState {
  return DEFAULT_THREAD_TERMINAL_STATE;
}

// ---------------------------------------------------------------------------
// State normalisation
// ---------------------------------------------------------------------------

export function normalizeThreadTerminalState(state: ThreadTerminalState): ThreadTerminalState {
  const terminalIds = normalizeTerminalIds(state.terminalIds);
  const nextTerminalIds = terminalIds.length > 0 ? terminalIds : [DEFAULT_THREAD_TERMINAL_ID];
  const runningTerminalIds = normalizeRunningTerminalIds(state.runningTerminalIds, nextTerminalIds);
  const activeTerminalId = nextTerminalIds.includes(state.activeTerminalId)
    ? state.activeTerminalId
    : (nextTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
  const terminalGroups = normalizeTerminalGroups(state.terminalGroups, nextTerminalIds);
  const activeGroupIdFromState = terminalGroups.some(
    (group) => group.id === state.activeTerminalGroupId,
  )
    ? state.activeTerminalGroupId
    : null;
  const activeGroupIdFromTerminal =
    terminalGroups.find((group) => group.terminalIds.includes(activeTerminalId))?.id ?? null;

  const normalized: ThreadTerminalState = {
    terminalOpen: state.terminalOpen,
    terminalHeight:
      Number.isFinite(state.terminalHeight) && state.terminalHeight > 0
        ? state.terminalHeight
        : DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalIds: nextTerminalIds,
    runningTerminalIds,
    activeTerminalId,
    terminalGroups,
    activeTerminalGroupId:
      activeGroupIdFromState ??
      activeGroupIdFromTerminal ??
      terminalGroups[0]?.id ??
      fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
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
