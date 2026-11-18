import { makeRemoteTerminalApi } from "./Manager.session.remote";
import { DEFAULT_TERMINAL_ID } from "@bigbud/contracts";
import * as Effect from "effect/Effect";
import { makeTerminalOpen } from "./Manager.session.open";
import { makeTerminalRestart } from "./Manager.session.restart.action";
import { makeTerminalSessionControls } from "./Manager.session.controls";
import { resetSessionRuntimeState } from "./Manager.session.state";
import { nextTerminalTimestamp } from "./Manager.session.timestamp";
import { subscribeToTerminalEvents } from "./Manager.session.subscription";
import { type SessionApiContext, type TerminalManagerShape } from "./Manager.session.types";
import { makeTerminalClose } from "./Manager.session.close";
import { makeTerminalOutputHold } from "./Manager.session.outputHold";
import { TerminalSearchIndex } from "./Manager.search";
import { captureTerminalRecovery } from "./Manager.recoveryRpc";
import { makeListTerminalShellProfiles } from "./Manager.shell.inventory";

export function buildSessionApi(ctx: SessionApiContext): TerminalManagerShape {
  const {
    withThreadLock,
    getSession,
    requireSession,
    sessionsForThread,
    modifyManagerState,
    flushPtyOutput,
    persistHistory,
    publishEvent,
    snapshot,
    terminalEventListeners,
  } = ctx;

  const open = makeTerminalOpen(ctx);

  const { write, resize } = makeTerminalSessionControls(requireSession);

  const clear: TerminalManagerShape["clear"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
        const session = yield* requireSession(input.threadId, terminalId);
        yield* flushPtyOutput(input.threadId, terminalId);
        resetSessionRuntimeState(session);
        session.updatedAt = nextTerminalTimestamp(session.updatedAt);
        yield* persistHistory(input.threadId, terminalId, session.history);
        yield* publishEvent({
          type: "cleared",
          threadId: input.threadId,
          terminalId,
          createdAt: session.updatedAt,
        });
      }),
    );

  const restart = makeTerminalRestart(ctx);

  const close = makeTerminalClose(ctx);
  const searchIndex = new TerminalSearchIndex();

  return {
    ...makeRemoteTerminalApi(ctx, open, close),
    hasActiveThread: (threadId) =>
      sessionsForThread(threadId).pipe(
        Effect.map((sessions) =>
          sessions.some((session) => session.status === "running" || session.hasRunningSubprocess),
        ),
      ),
    listExecutionTargetSessions: (executionTargetId) =>
      modifyManagerState((state) => [Array.from(state.sessions.values()), state] as const).pipe(
        Effect.map((sessions) =>
          sessions
            .filter((session) => session.executionTargetId === executionTargetId)
            .map(({ threadId, terminalId }) => ({ threadId, terminalId })),
        ),
      ),
    open,
    listShellProfiles: makeListTerminalShellProfiles(ctx),
    // Retained lifecycle/identity is authoritative even after exit or a failed launch.
    snapshot: (input) =>
      requireSession(input.threadId, input.terminalId ?? DEFAULT_TERMINAL_ID).pipe(
        Effect.map(snapshot),
      ),
    recovery: (input) =>
      requireSession(input.threadId, input.terminalId).pipe(
        Effect.flatMap((session) => captureTerminalRecovery(session, input)),
      ),
    write,
    resize,
    clear,
    restart,
    close,
    subscribe: (listener, options) =>
      subscribeToTerminalEvents(
        { modifyManagerState, terminalEventListeners, getSession },
        listener,
        options,
      ),
    setOutputHold: makeTerminalOutputHold(getSession),
    search: (input) =>
      modifyManagerState((state) => [Array.from(state.sessions.values()), state] as const).pipe(
        Effect.map((sessions) => searchIndex.search(sessions, input)),
      ),
  };
}
