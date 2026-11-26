/**
 * Provider-log and terminal-history files a thread deletion removes. Terminal history follows
 * the retained-pane rule (`TerminalHistoryRetention`); the terminal close after the deletion
 * commits, and the orphaned-history sweep, remove what later proves free.
 *
 * @module ThreadDeletion.logs
 */
import type { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import { exclusiveOwnedLogNames, readOwnedLogDirectory } from "./EntityPurge.logs.ts";
import {
  keptTerminalHistoryNames,
  type RetainedTerminalHistory,
} from "./TerminalHistoryRetention.ts";
import type { PurgeResource } from "../../persistence/Services/PurgeJobRepository.ts";
import { ServerConfig } from "../../startup/config.ts";

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
            ? yield* keptTerminalHistoryNames(threadId, names, input.retainedTerminalHistory)
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
