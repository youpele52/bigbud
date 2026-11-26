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
import { makeRetainedShellOwnerApi } from "./Manager.session.shellOwners";
import { retainedThreadHistoryTerminalIds } from "./Manager.history.retainedPanes";
import { sweepOrphanedTerminalHistory } from "./Manager.history.orphans";
import { makeTerminalOutputHold } from "./Manager.session.outputHold";
import { TerminalSearchIndex } from "./Manager.search";
import { captureTerminalRecovery } from "./Manager.recoveryRpc";
import { makeListTerminalShellProfiles } from "./Manager.shell.inventory";
import { isRemoteAgentExecutionTarget } from "../../remote-agent/remoteAgentDefault.ts";
import { parseSshExecutionTarget } from "../../ssh/sshExecutionTarget.ts";

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

  const { write, resize } = makeTerminalSessionControls(requireSession, ctx.workSignals);

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
    ...makeRetainedShellOwnerApi(ctx),
    retainedHistoryTerminalIds: (threadId) => retainedThreadHistoryTerminalIds(ctx, threadId),
    sweepOrphanedHistory: (missingThreadIds) => sweepOrphanedTerminalHistory(ctx, missingThreadIds),
    hasActiveThread: (threadId) =>
      sessionsForThread(threadId).pipe(
        Effect.map((sessions) =>
          sessions.some((session) => session.status === "running" || session.hasRunningSubprocess),
        ),
      ),
    listDrainPanes: () =>
      modifyManagerState((state) => [Array.from(state.sessions.values()), state] as const).pipe(
        Effect.map((sessions) => {
          const keepMode = ctx.keepRunningAfterQuit?.() === true;
          return sessions.map((session) => ({
            threadId: session.threadId,
            terminalId: session.terminalId,
            executionTargetId: session.executionTargetId,
            surface: isRemoteAgentExecutionTarget(session.executionTargetId)
              ? ("remote-agent" as const)
              : parseSshExecutionTarget(session.executionTargetId) !== null
                ? ("direct-ssh" as const)
                : ("local" as const),
            keepMode,
          }));
        }),
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
        {
          modifyManagerState,
          terminalEventListeners,
          getSession,
          hostInventory: ctx.hostInventory,
        },
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
