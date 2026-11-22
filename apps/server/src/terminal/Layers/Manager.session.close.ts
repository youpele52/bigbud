import {
  assertDirectShellCloseAvailable,
  assertDirectShellThreadCloseAvailable,
} from "./Manager.shell.direct.policy";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  type TerminalCloseInput,
  TerminalExecutionTargetError,
} from "@bigbud/contracts/workspace/terminal.ts";
import { toSessionKey } from "./Manager.shell";
import type { SessionApiContext, TerminalManagerShape } from "./Manager.session.types";
import { assertTerminalGeneration } from "./Manager.session.generation";
import { knownThreadTerminalIds } from "./Manager.session.shellOwners";
import {
  retainedHistoryTerminalIds,
  retainedThreadHistoryTerminalIds,
} from "./Manager.history.retainedPanes";
import {
  assertHostedDirectShellsReachable,
  settleHostedDirectShellPane,
} from "./Manager.shell.direct.settle";
import {
  assertHostRosterPanesReachable,
  hostRosterPanesForThread,
  settleHostRosterPane,
} from "./Manager.session.close.hostRoster";
import { resolveExecutionTargetId } from "@bigbud/contracts";
import { sessionOwnedPtyRuntime } from "./OwnedPtyRuntime.resolve.ts";
import { ownedTerminalMayBeRetained } from "./OwnedPtyRuntime.owner.ts";
import {
  annotateTerminalCloseSpan,
  DEFAULT_TERMINAL_CLOSE_REASON,
  type TerminalCloseReason,
} from "./Manager.process.stop";

/** `reason` is optional so existing callers keep closing as `user-close`. */
export function makeTerminalClose(
  ctx: SessionApiContext,
): (
  input: TerminalCloseInput,
  reason?: TerminalCloseReason,
) => ReturnType<TerminalManagerShape["close"]> {
  /**
   * The subset of `terminalIds` whose history may go: panes with an owner record or host PTY
   * keep theirs (N8), and an unreadable source keeps them all.
   */
  const historyDeletable = Effect.fn("terminal.historyDeletable")(function* (
    threadId: string,
    terminalIds: ReadonlyArray<string>,
    confirmedStopped: ReadonlySet<string>,
  ) {
    const retained = yield* retainedHistoryTerminalIds(
      ctx,
      threadId,
      terminalIds,
      confirmedStopped,
    );
    if (retained === "unknown") {
      yield* Effect.logWarning("kept terminal history: its owner records could not be read", {
        threadId,
      });
      return new Set<string>();
    }
    return new Set(terminalIds.filter((terminalId) => !retained.has(terminalId)));
  });
  const deleteThreadHistory = Effect.fn("terminal.deleteThreadHistory")(function* (
    threadId: string,
    confirmedStopped: ReadonlySet<string>,
  ) {
    const retained = yield* retainedThreadHistoryTerminalIds(ctx, threadId, confirmedStopped);
    if (retained === "unknown") {
      yield* Effect.logWarning("kept terminal history: its panes could not be resolved", {
        threadId,
      });
      return;
    }
    yield* ctx.deleteAllHistoryForThread(threadId, retained);
  });
  const closeSession = Effect.fn("terminal.closeSession")(function* (
    threadId: string,
    terminalId: string,
    deleteHistory: boolean,
    reason: TerminalCloseReason,
    expectedGeneration?: string,
    onlyIfNotRunning = false,
    executionTargetId?: string,
  ) {
    yield* annotateTerminalCloseSpan(threadId, terminalId, reason);
    const key = toSessionKey(threadId, terminalId);
    const session = yield* ctx.getSession(threadId, terminalId);
    if (Option.isSome(session)) yield* assertTerminalGeneration(session.value, expectedGeneration);
    yield* assertDirectShellCloseAvailable(
      ctx.directShellOwners,
      {
        threadId,
        terminalId,
        executionTargetId: Option.isSome(session) ? session.value.executionTargetId : "unknown",
      },
      Option.getOrUndefined(session),
    );
    // A recovered remote owner can outlive the server session map. History is its existing
    // recovery marker; do not discard it or its lease while shutdown identity is unknown.
    // Only the pane target's durable owner store can prove no owned process survives.
    const ownedRuntime = executionTargetId
      ? sessionOwnedPtyRuntime(ctx, resolveExecutionTargetId(executionTargetId))
      : undefined;
    if (
      Option.isNone(session) &&
      (onlyIfNotRunning || expectedGeneration !== undefined) &&
      (yield* ctx.historyExists(threadId, terminalId)) &&
      (!ownedRuntime || (yield* ownedTerminalMayBeRetained(ownedRuntime, threadId, terminalId)))
    ) {
      return yield* new TerminalExecutionTargetError({
        threadId,
        terminalId,
        executionTargetId: "unknown",
        detail:
          "Previous terminal ownership has not been recovered. Reconnect to its original target before closing it; its history was retained.",
      });
    }
    const heldLive = Option.isSome(session) && session.value.process !== null;
    if (Option.isSome(session)) {
      if (
        session.value.remoteOwnerRecoveryRequired ||
        (onlyIfNotRunning && (session.value.process || session.value.restartPreparation))
      ) {
        return yield* new TerminalExecutionTargetError({
          threadId,
          terminalId,
          executionTargetId: session.value.executionTargetId,
          detail:
            "Terminal ownership is unresolved or its identity is unavailable. Reconnect before closing it; a process may still be running.",
        });
      }
      yield* ctx.flushPtyOutput(threadId, terminalId);
      yield* ctx.stopProcess(session.value);
      yield* ctx.persistHistory(threadId, terminalId, session.value.history);
    }
    // A Direct SSH pane in the local host (M7) is closed there even with no session holding it.
    yield* settleHostedDirectShellPane(ctx, threadId, terminalId);
    // A host pane no live session holds (kept across a backend restart) is ended there too.
    if (!heldLive) yield* settleHostRosterPane(ctx, threadId, terminalId);
    yield* ctx.releaseWorktreeLease({ threadId, terminalId });
    yield* ctx.flushPersist(threadId, terminalId);
    yield* ctx.modifyManagerState((state) => {
      if (!state.sessions.has(key)) return [undefined, state] as const;
      const sessions = new Map(state.sessions);
      sessions.delete(key);
      return [undefined, { ...state, sessions }] as const;
    });
    const stopped = new Set(Option.isSome(session) ? [terminalId] : []);
    if (deleteHistory && (yield* historyDeletable(threadId, [terminalId], stopped)).size > 0)
      yield* ctx.deleteHistory(threadId, terminalId);
  });
  return (input, reason = DEFAULT_TERMINAL_CLOSE_REASON) =>
    ctx.withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (input.onlyIfNotRunning && !input.terminalId) {
          return yield* new TerminalExecutionTargetError({
            threadId: input.threadId,
            terminalId: "unknown",
            executionTargetId: "unknown",
            detail:
              "A terminal ID is required to confirm that an unidentified terminal is stopped.",
          });
        }
        if (input.terminalId) {
          yield* closeSession(
            input.threadId,
            input.terminalId,
            input.deleteHistory === true,
            reason,
            input.expectedGeneration,
            input.onlyIfNotRunning,
            input.executionTargetId,
          );
          return;
        }
        yield* assertDirectShellThreadCloseAvailable(
          ctx.directShellOwners,
          input.threadId,
          yield* knownThreadTerminalIds(ctx, input.threadId),
        );
        const sessions = yield* ctx.sessionsForThread(input.threadId);
        const livePanes = new Set(
          sessions.filter((session) => session.process).map((session) => session.terminalId),
        );
        // Hosted Direct SSH panes and kept host panes block only while their host is
        // unreachable; checked first so nothing is closed when one cannot be.
        const hosted = yield* assertHostedDirectShellsReachable(ctx, input.threadId, livePanes);
        const roster = hostRosterPanesForThread(ctx, input.threadId, livePanes);
        yield* assertHostRosterPanesReachable(ctx, input.threadId, roster);
        const terminalIds = new Set([
          ...sessions.map((session) => session.terminalId),
          ...hosted.map((record) => record.pane.terminalId),
          ...roster,
        ]);
        yield* Effect.forEach(
          terminalIds,
          (terminalId) =>
            closeSession(
              input.threadId,
              terminalId,
              false,
              reason,
              input.expectedGeneration,
              input.onlyIfNotRunning,
            ),
          { discard: true },
        );
        if (input.deleteHistory) yield* deleteThreadHistory(input.threadId, terminalIds);
      }),
    );
}
