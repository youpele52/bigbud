/**
 * The orphaned terminal-history sweep (plan Q1, N8). A thread deletion can leave a pane's history
 * file behind while the retained-pane rule holds it (a direct-shell owner record, a live host
 * owner row or a lost host PTY), and the purge-job path leaves held files out of its manifest.
 * Once the thread is gone from the projection and nothing holds the pane any more, this sweep
 * removes the file. It deletes nothing for a thread that still has a session or whose owner
 * sources cannot be read, and skips legacy `<id>.log` names, which do not encode the thread id
 * losslessly.
 *
 * @module Manager.history.orphans
 */
import path from "node:path";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { historyFileTerminalId } from "./Manager.history-io";
import { retainedThreadHistoryTerminalIds } from "./Manager.history.retainedPanes";
import { toSafeThreadId } from "./Manager.shell";
import type { SessionApiContext } from "./Manager.session.types";

const SAFE_PREFIX = "terminal_";

/** Every thread id whose exact encoding names this history file (base64url can be ambiguous). */
export function historyFileThreadIds(name: string): ReadonlyArray<string> {
  if (!name.startsWith(SAFE_PREFIX) || !name.endsWith(".log")) return [];
  const body = name.slice(SAFE_PREFIX.length, -".log".length);
  const splits = [body.length];
  for (let index = 0; index < body.length; index++) if (body[index] === "_") splits.push(index);
  const threadIds = new Set<string>();
  for (const split of splits) {
    const encoded = body.slice(0, split);
    if (encoded.length === 0) continue;
    const threadId = Buffer.from(encoded, "base64url").toString("utf8");
    if (toSafeThreadId(threadId) !== `${SAFE_PREFIX}${encoded}`) continue;
    if (historyFileTerminalId(name, threadId) !== undefined) threadIds.add(threadId);
  }
  return [...threadIds];
}

/** History file names, or `"unknown"` when the directory cannot be read. */
export const listHistoryFileNames = Effect.fn("terminal.listHistoryFileNames")(function* (
  logsDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readDirectory(logsDir, { recursive: false }).pipe(
    Effect.map((names): ReadonlyArray<string> | "unknown" => names),
    Effect.catch((error) =>
      Effect.succeed(error.reason._tag === "NotFound" ? [] : ("unknown" as const)),
    ),
  );
});

export const removeHistoryFile = Effect.fn("terminal.removeHistoryFile")(function* (
  logsDir: string,
  name: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.remove(path.join(logsDir, name), { force: true }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to delete orphaned terminal history", {
        name,
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
  );
});

/** Of `threadIds`, those with no row in the projection (the thread is truly gone). */
export type MissingThreadIds = (
  threadIds: ReadonlyArray<string>,
) => Effect.Effect<ReadonlySet<string>>;

type SweepContext = Pick<
  SessionApiContext,
  | "withThreadLock"
  | "sessionsForThread"
  | "historyTerminalIdsForThread"
  | "directShellOwners"
  | "hostLimit"
  | "historyFileNames"
  | "removeHistoryFile"
>;

export interface OrphanedHistorySweepResult {
  readonly removed: number;
  readonly kept: number;
}

/** Why a gone thread's files must stay: a live session or unreadable owners hold them all. */
type ThreadHold = "all" | ReadonlySet<string>;

export const sweepOrphanedTerminalHistory = Effect.fn("terminal.sweepOrphanedHistory")(function* (
  ctx: SweepContext,
  missingThreadIds: MissingThreadIds,
) {
  const names = yield* ctx.historyFileNames();
  if (names === "unknown") return { removed: 0, kept: 0 } satisfies OrphanedHistorySweepResult;
  // A base64url name can parse as more than one thread; a file is an orphan only when every
  // thread it could belong to is gone, and it goes only when none of them holds its pane.
  const files = names.flatMap((name) => {
    const owners = historyFileThreadIds(name).map((threadId) => ({
      threadId,
      terminalId: historyFileTerminalId(name, threadId)!,
    }));
    return owners.length > 0 ? [{ name, owners }] : [];
  });
  if (files.length === 0) return { removed: 0, kept: 0 } satisfies OrphanedHistorySweepResult;
  const missing = yield* missingThreadIds([
    ...new Set(files.flatMap((file) => file.owners.map((owner) => owner.threadId))),
  ]);
  const orphans = files.filter((file) => file.owners.every((owner) => missing.has(owner.threadId)));
  const holds = new Map<string, ThreadHold>();
  for (const threadId of new Set(orphans.flatMap((file) => file.owners.map((o) => o.threadId)))) {
    holds.set(
      threadId,
      yield* ctx.withThreadLock(
        threadId,
        Effect.gen(function* () {
          if ((yield* ctx.sessionsForThread(threadId)).length > 0) return "all" as const;
          const retained = yield* retainedThreadHistoryTerminalIds(ctx, threadId);
          if (retained !== "unknown") return retained;
          yield* Effect.logWarning("kept orphaned terminal history: its panes are unresolved", {
            threadId,
          });
          return "all" as const;
        }),
      ),
    );
  }
  let removed = 0;
  for (const file of orphans) {
    const held = file.owners.some(({ threadId, terminalId }) => {
      const hold = holds.get(threadId) ?? "all";
      return hold === "all" || hold.has(terminalId);
    });
    if (held) continue;
    yield* ctx.removeHistoryFile(file.name);
    removed += 1;
  }
  return { removed, kept: orphans.length - removed } satisfies OrphanedHistorySweepResult;
});
