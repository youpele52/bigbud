/**
 * The provider-log and terminal-history files a thread purge job claims, and the check that they
 * are gone afterwards. Terminal history follows the retained-pane rule (plan Q1, N8,
 * `TerminalHistoryRetention`): a held pane's file stays out of the manifest, so verification
 * tolerates a pane file the manifest does not list. Once the thread's root row is gone, the
 * orphaned-history sweep removes such files when nothing holds them any more.
 *
 * @module EntityPurge.threadLogs
 */
import type { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { PurgeJob, PurgeResource } from "../../persistence/Services/PurgeJobRepository.ts";
import type { ServerConfigShape } from "../../startup/config.ts";
import { historyFileTerminalId } from "../../terminal/Layers/Manager.history-io.ts";
import { purgeResourceOperation } from "./EntityPurge.errors.ts";
import {
  exclusiveOwnedLogNames,
  readOwnedLogDirectory,
  verifyOwnedLogsAbsent,
} from "./EntityPurge.logs.ts";
import {
  keptTerminalHistoryNames,
  type RetainedTerminalHistory,
} from "./TerminalHistoryRetention.ts";

type LogConfig = Pick<ServerConfigShape, "providerLogsDir" | "terminalLogsDir">;

/** The thread's exclusively owned log files the purge may delete. */
export const listPurgeThreadLogResources = Effect.fn("EntityPurge.listThreadLogs")(
  function* (input: {
    readonly config: LogConfig;
    readonly knownThreadIds: ReadonlyArray<string>;
    readonly threadId: ThreadId;
    readonly retainedTerminalHistory: RetainedTerminalHistory;
  }) {
    const owned: Array<{ kind: PurgeResource["kind"]; relativePath: string }> = [];
    for (const [kind, directory, type] of [
      ["provider-log", input.config.providerLogsDir, "provider"],
      ["terminal-history", input.config.terminalLogsDir, "terminal"],
    ] as const) {
      const entries = yield* purgeResourceOperation("EntityPurge.readOwnedLogDirectory", () =>
        readOwnedLogDirectory(directory),
      );
      const names = exclusiveOwnedLogNames({
        entries,
        knownThreadIds: input.knownThreadIds,
        threadId: input.threadId,
        type,
      });
      const kept =
        type === "terminal"
          ? yield* keptTerminalHistoryNames(input.threadId, names, input.retainedTerminalHistory)
          : new Set<string>();
      for (const relativePath of names)
        if (!kept.has(relativePath)) owned.push({ kind, relativePath });
    }
    return owned;
  },
);

/** Fails when a provider log, a claimed history file or a non-pane history file remains. */
export function verifyPurgeThreadLogsAbsent(input: {
  readonly config: LogConfig;
  readonly knownThreadIds: ReadonlyArray<string>;
  readonly job: Pick<PurgeJob, "entityId" | "resourceManifest">;
}) {
  const threadId = input.job.entityId;
  const claimed = new Set(
    input.job.resourceManifest.flatMap((resource) =>
      resource.kind === "terminal-history" ? [resource.relativePath] : [],
    ),
  );
  return purgeResourceOperation("EntityPurge.verifyOwnedLogs", () =>
    verifyOwnedLogsAbsent({
      providerDirectory: input.config.providerLogsDir,
      terminalDirectory: input.config.terminalLogsDir,
      knownThreadIds: input.knownThreadIds,
      threadId,
      // A pane file left out of the manifest was held by the retained-pane rule.
      tolerate: (type, name) =>
        type === "terminal" &&
        !claimed.has(name) &&
        historyFileTerminalId(name, threadId) !== undefined,
    }),
  );
}
