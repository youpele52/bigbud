import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import type {
  ActivePiSession,
  PiEmitEvents,
  PiProcessExitHandler,
  PiSyntheticEventFn,
} from "./Adapter.types.ts";
export { makeHandleStdoutEvent } from "./Adapter.stream.stdout.ts";

export function makeHandleProcessExit(deps: {
  readonly emit: PiEmitEvents;
  readonly makeSyntheticEvent: PiSyntheticEventFn;
  readonly sessions: Map<ThreadId, ActivePiSession>;
}): PiProcessExitHandler {
  return Effect.fn("handleProcessExit")(function* (session, detail) {
    if (!deps.sessions.has(session.threadId)) {
      return;
    }

    deps.sessions.delete(session.threadId);
    session.lastError = detail;
    session.agentRunning = false;
    session.activeTurnId = undefined;
    session.pendingTurnEnd = undefined;
    session.completedTurnBoundary = undefined;

    yield* Effect.logWarning("Pi RPC process exited", {
      threadId: session.threadId,
      detail,
    });

    yield* deps.emit([
      yield* deps.makeSyntheticEvent(session.threadId, "session.state.changed", {
        state: "stopped",
        reason: detail,
      }),
      yield* deps.makeSyntheticEvent(session.threadId, "session.exited", {
        reason: detail,
        recoverable: true,
        exitKind: "error",
      }),
    ]);
  });
}
