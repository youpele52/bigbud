/**
 * The retained-pane rule (plan Q1, N8) as the deletion paths apply it to terminal-history files.
 * A pane that still has a direct-shell owner record, a live host owner row or a lost host PTY
 * keeps its file, because that file is how the thread keeps recognising the pane for its deletion
 * guard. An unreadable source keeps all of the thread's terminal history. The terminal manager
 * owns the rule (`retainedThreadHistoryTerminalIds`); this module only maps it onto file names.
 *
 * @module TerminalHistoryRetention
 */
import type { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import { historyFileTerminalId } from "../../terminal/Layers/Manager.history-io.ts";
import type { TerminalManagerShape } from "../../terminal/Services/Manager.ts";

/** A thread's panes whose history must survive, or `"unknown"` when that cannot be read. */
export type RetainedTerminalHistory = (
  threadId: ThreadId,
) => Effect.Effect<ReadonlySet<string> | "unknown">;

/**
 * The terminal manager's retained panes. Without a manager that can report them every pane
 * counts as retained; the orphaned-history sweep removes the files once nothing holds them.
 */
export function terminalManagerRetainedHistory(
  terminal: Pick<TerminalManagerShape, "retainedHistoryTerminalIds"> | undefined,
): RetainedTerminalHistory {
  return (threadId) =>
    terminal?.retainedHistoryTerminalIds?.(threadId) ?? Effect.succeed("unknown" as const);
}

/** The subset of a thread's terminal-history `names` the retained-pane rule keeps. */
export const keptTerminalHistoryNames = Effect.fn("deletion.keptTerminalHistoryNames")(function* (
  threadId: ThreadId,
  names: ReadonlyArray<string>,
  retainedTerminalHistory: RetainedTerminalHistory,
) {
  if (names.length === 0) return new Set<string>();
  const retained = yield* retainedTerminalHistory(threadId);
  if (retained === "unknown") {
    yield* Effect.logWarning("kept terminal history: its panes are unresolved", { threadId });
    return new Set(names);
  }
  return new Set(
    names.filter((name) => {
      const terminalId = historyFileTerminalId(name, threadId);
      return terminalId !== undefined && retained.has(terminalId);
    }),
  );
});
