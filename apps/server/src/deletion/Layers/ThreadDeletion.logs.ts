/**
 * Provider-log and terminal-history files a thread deletion removes. Terminal history follows
 * the terminal manager's retained-pane rule (plan Q1, N8): a pane that still has a direct-shell
 * owner record or a host PTY keeps its file, because that file is how the thread keeps
 * recognising the pane for its deletion guard. An unreadable source keeps all of the thread's
 * terminal history; the terminal close after the deletion commits removes what it can prove free.
 *
 * @module ThreadDeletion.logs
 */
import type { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import { exclusiveOwnedLogNames, readOwnedLogDirectory } from "./EntityPurge.logs.ts";
import type { PurgeResource } from "../../persistence/Services/PurgeJobRepository.ts";
import { ServerConfig } from "../../startup/config.ts";
import { historyFileTerminalId } from "../../terminal/Layers/Manager.history-io.ts";

/** A thread's panes whose history must survive, or `"unknown"` when that cannot be read. */
export type RetainedTerminalHistory = (
  threadId: ThreadId,
) => Effect.Effect<ReadonlySet<string> | "unknown">;

const keptTerminalHistory = Effect.fn("ThreadDeletion.keptTerminalHistory")(function* (
  threadId: ThreadId,
  names: ReadonlyArray<string>,
  retainedTerminalHistory: RetainedTerminalHistory,
) {
  if (names.length === 0) return new Set<string>();
  const retained = yield* retainedTerminalHistory(threadId);
  if (retained === "unknown") {
    yield* Effect.logWarning("thread deletion kept terminal history: its panes are unresolved", {
      threadId,
    });
    return new Set(names);
  }
  return new Set(
    names.filter((name) => {
      const terminalId = historyFileTerminalId(name, threadId);
      return terminalId !== undefined && retained.has(terminalId);
    }),
  );
});

/** The log files owned exclusively by `threadIds` that the deletion may remove. */
export const discoverThreadLogResources = Effect.fn("ThreadDeletion.discoverLogs")(
  function* (input: {
    readonly threadIds: ReadonlyArray<ThreadId>;
    readonly knownThreadIds: ReadonlyArray<string>;
    readonly retainedTerminalHistory: RetainedTerminalHistory;
  }) {
    const config = yield* ServerConfig;
    const resources: Array<PurgeResource> = [];
    for (const [kind, directory, type] of [
      ["provider-log", config.providerLogsDir, "provider"],
      ["terminal-history", config.terminalLogsDir, "terminal"],
    ] as const) {
      const entries = yield* Effect.tryPromise(() => readOwnedLogDirectory(directory));
      for (const threadId of input.threadIds) {
        const names = exclusiveOwnedLogNames({
          entries,
          knownThreadIds: input.knownThreadIds,
          threadId,
          type,
        });
        const kept =
          type === "terminal"
            ? yield* keptTerminalHistory(threadId, names, input.retainedTerminalHistory)
            : new Set<string>();
        for (const relativePath of names) {
          if (kept.has(relativePath)) continue;
          resources.push({
            kind,
            relativePath,
            identity: null,
            quarantineName: null,
            action: "delete",
          });
        }
      }
    }
    return resources;
  },
);
