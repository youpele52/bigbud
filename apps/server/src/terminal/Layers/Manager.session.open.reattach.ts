import { resolveExecutionTargetId, type TerminalSessionSnapshot } from "@bigbud/contracts";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import * as Effect from "effect/Effect";

import { resizeWithRecovery } from "./Manager.recovery";
import { nextTerminalTimestamp } from "./Manager.session.timestamp";
import type { SessionApiContext, TerminalManagerShape } from "./Manager.session.types.ts";
import { assertTerminalShellReattach } from "./Manager.shell.profile";
import type { TerminalSessionState } from "./Manager.types";

/**
 * Open on a session that still has a process: reattach, never reinterpret mutable chat launch
 * settings as a restart. A remote process is confirmed first, then the view's size is applied.
 */
export const reattachRunningTerminalSession = Effect.fn("terminal.reattachRunningSession")(
  function* (input: {
    readonly ctx: SessionApiContext;
    readonly session: TerminalSessionState;
    readonly request: Parameters<TerminalManagerShape["open"]>[0];
    readonly terminalId: string;
    readonly expectedRemoteResourceId: string | undefined;
    readonly unconfirmed: () => TerminalExecutionTargetError;
  }): Effect.fn.Return<TerminalSessionSnapshot, TerminalExecutionTargetError> {
    const { ctx, session, request, terminalId, unconfirmed } = input;
    if (
      input.expectedRemoteResourceId &&
      session.process?.remoteResourceId !== input.expectedRemoteResourceId
    )
      return yield* new TerminalExecutionTargetError({
        threadId: request.threadId,
        terminalId,
        executionTargetId: session.executionTargetId,
        detail: "Discovered terminal identity changed. Refresh discovery before attaching.",
      });
    yield* assertTerminalShellReattach(
      session,
      resolveExecutionTargetId(request.executionTargetId),
      request.shellSelection,
      ctx,
    );
    const process = session.process!;
    const runtimeEpoch = session.runtimeEpoch;
    if (process.reconnectRemote) {
      // Bound this caller's wait, not the shared same-identity reconnect
      // episode. A late completion must not retain the thread lock or
      // continue this open into resize/snapshot/launch work.
      yield* Effect.tryPromise({
        try: (signal) => process.reconnectRemote!(signal),
        catch: unconfirmed,
      }).pipe(
        Effect.timeoutOrElse({
          duration: 15_000,
          orElse: () => Effect.fail(unconfirmed()),
        }),
      );
      if (
        session.process !== process ||
        session.runtimeEpoch !== runtimeEpoch ||
        session.observedExit?.process === process
      )
        return yield* unconfirmed();
      session.pid = process.pid;
      session.status = "running";
      session.updatedAt = nextTerminalTimestamp(session.updatedAt);
    }
    const cols = request.cols ?? session.cols;
    const rows = request.rows ?? session.rows;
    if (session.cols !== cols || session.rows !== rows) {
      session.cols = cols;
      session.rows = rows;
      session.updatedAt = nextTerminalTimestamp(session.updatedAt);
      // Reattach must not fail on a resize race with a process that is exiting.
      const resizeError = yield* Effect.sync(() => {
        try {
          resizeWithRecovery(session, process, cols, rows);
          return null;
        } catch (cause) {
          return cause instanceof Error ? cause.message : String(cause);
        }
      });
      if (resizeError !== null) {
        yield* Effect.logDebug("terminal reattach resize failed", {
          threadId: session.threadId,
          terminalId,
          error: resizeError,
        });
      }
    }
    return ctx.snapshot(session);
  },
);
