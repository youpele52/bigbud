/**
 * Store-level event buffer helpers for the terminal Zustand store.
 *
 * These helpers operate on the flat `terminalEventEntriesByKey` map that is
 * keyed by a composite `threadId\0terminalId` string, and on the associated
 * `ThreadTerminalLaunchContext` derived from terminal start/restart events.
 *
 * @module helpers.events.store
 */

import { ThreadId, type TerminalEvent } from "@bigbud/contracts";

import type { TerminalEventEntry, ThreadTerminalLaunchContext } from "./helpers.store";
import { EMPTY_TERMINAL_EVENT_ENTRIES, MAX_TERMINAL_EVENT_BUFFER } from "./helpers.store";

// ---------------------------------------------------------------------------
// Key construction
// ---------------------------------------------------------------------------

/** Composite key used to index per-terminal event buffers in the store. */
export function terminalEventBufferKey(threadId: ThreadId, terminalId: string): string {
  return `${threadId}\u0000${terminalId}`;
}

// ---------------------------------------------------------------------------
// Thread-terminal state selectors (store-level)
// ---------------------------------------------------------------------------

export function selectTerminalEventEntries(
  terminalEventEntriesByKey: Record<string, ReadonlyArray<TerminalEventEntry>>,
  threadId: ThreadId,
  terminalId: string,
): ReadonlyArray<TerminalEventEntry> {
  if (threadId.length === 0 || terminalId.trim().length === 0) {
    return EMPTY_TERMINAL_EVENT_ENTRIES;
  }
  return (
    terminalEventEntriesByKey[terminalEventBufferKey(threadId, terminalId)] ??
    EMPTY_TERMINAL_EVENT_ENTRIES
  );
}

// ---------------------------------------------------------------------------
// Event buffer mutations (return new state — no side effects)
// ---------------------------------------------------------------------------

export function appendTerminalEventEntry(
  terminalEventEntriesByKey: Record<string, ReadonlyArray<TerminalEventEntry>>,
  nextTerminalEventId: number,
  event: TerminalEvent,
) {
  const key = terminalEventBufferKey(ThreadId.makeUnsafe(event.threadId), event.terminalId);
  const currentEntries = terminalEventEntriesByKey[key] ?? EMPTY_TERMINAL_EVENT_ENTRIES;
  const nextEntry: TerminalEventEntry = {
    id: nextTerminalEventId,
    event,
  };
  const nextEntries =
    currentEntries.length >= MAX_TERMINAL_EVENT_BUFFER
      ? [...currentEntries.slice(1), nextEntry]
      : [...currentEntries, nextEntry];

  return {
    terminalEventEntriesByKey: {
      ...terminalEventEntriesByKey,
      [key]: nextEntries,
    },
    nextTerminalEventId: nextTerminalEventId + 1,
  };
}

// ---------------------------------------------------------------------------
// Launch-context derivation
// ---------------------------------------------------------------------------

export function launchContextFromStartEvent(
  event: Extract<TerminalEvent, { type: "started" | "restarted" }>,
): ThreadTerminalLaunchContext {
  return {
    cwd: event.snapshot.cwd,
    worktreePath: event.snapshot.worktreePath,
  };
}
