/**
 * ClaudeAdapter stream - session lifecycle and factory wiring.
 *
 * This module is the entry point for stream handling. It wires together
 * block, turn, and message handler sub-modules into a single `makeStreamHandlers`
 * factory that preserves the original closure-based session semantics.
 *
 * @module ClaudeAdapter.stream
 */
import { type EventId, type ProviderRuntimeEvent, ThreadId } from "@bigbud/contracts";
import { Cause, Deferred, Effect, Exit, Fiber, Queue, Stream } from "effect";

import {
  asCanonicalTurnId,
  asRuntimeRequestId,
  interruptionMessageFromClaudeCause,
  isClaudeInterruptedCause,
  messageFromClaudeStreamCause,
  nativeProviderRefs,
  toError,
} from "./ClaudeAdapter.utils.ts";
import type { ClaudeSessionContext } from "./ClaudeAdapter.types.ts";
import { PROVIDER } from "./ClaudeAdapter.types.ts";
import { makeBlockHandlers } from "./ClaudeAdapter.stream.blocks.ts";
import { makeTurnHandlers } from "./ClaudeAdapter.stream.turn.ts";
import { makeMessageHandlers } from "./ClaudeAdapter.stream.handlers.ts";

/** Shared dependencies injected into all stream handler functions. */
export interface StreamHandlerDeps {
  readonly makeEventStamp: () => Effect.Effect<{
    eventId: EventId;
    createdAt: string;
  }>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly nowIso: Effect.Effect<string>;
  readonly sessions: Map<ThreadId, ClaudeSessionContext>;
}

export const makeStreamHandlers = (deps: StreamHandlerDeps) => {
  const { makeEventStamp, offerRuntimeEvent, nowIso, sessions } = deps;

  const blockDeps = { makeEventStamp, offerRuntimeEvent };
  const blocks = makeBlockHandlers(blockDeps);

  const turnDeps = { makeEventStamp, offerRuntimeEvent, nowIso, sessions, blocks };
  const turn = makeTurnHandlers(turnDeps);

  const messageDeps = { makeEventStamp, offerRuntimeEvent, nowIso, blocks, turn };
  const messages = makeMessageHandlers(messageDeps);

  const runSdkStream = (context: ClaudeSessionContext): Effect.Effect<void, Error> =>
    Stream.fromAsyncIterable(context.query, (cause) =>
      toError(cause, "Claude runtime stream failed."),
    ).pipe(
      Stream.takeWhile(() => !context.stopped),
      Stream.runForEach((message) => messages.handleSdkMessage(context, message)),
    );

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    context: ClaudeSessionContext,
    options?: { readonly emitExitEvent?: boolean },
  ) {
    if (context.stopped) return;

    context.stopped = true;

    for (const [requestId, pending] of context.pendingApprovals) {
      yield* Deferred.succeed(pending.decision, "cancel");
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "request.resolved",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        requestId: asRuntimeRequestId(requestId),
        payload: {
          requestType: pending.requestType,
          decision: "cancel",
        },
        providerRefs: nativeProviderRefs(context),
      });
    }
    context.pendingApprovals.clear();

    if (context.turnState) {
      yield* turn.completeTurn(context, "interrupted", "Session stopped.");
    }

    yield* Queue.shutdown(context.promptQueue);

    const streamFiber = context.streamFiber;
    context.streamFiber = undefined;
    if (streamFiber && streamFiber.pollUnsafe() === undefined) {
      yield* Fiber.interrupt(streamFiber);
    }

    // @effect-diagnostics-next-line tryCatchInEffectGen:off
    try {
      context.query.close();
    } catch (cause) {
      yield* turn.emitRuntimeError(context, "Failed to close Claude runtime query.", cause);
    }

    const updatedAt = yield* nowIso;
    context.session = {
      ...context.session,
      status: "closed",
      activeTurnId: undefined,
      updatedAt,
    };

    if (options?.emitExitEvent !== false) {
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.exited",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          reason: "Session stopped",
          exitKind: "graceful",
        },
        providerRefs: {},
      });
    }

    sessions.delete(context.session.threadId);
  });

  const handleStreamExit = Effect.fn("handleStreamExit")(function* (
    context: ClaudeSessionContext,
    exit: Exit.Exit<void, Error>,
  ) {
    if (context.stopped) {
      return;
    }

    if (Exit.isFailure(exit)) {
      if (isClaudeInterruptedCause(exit.cause)) {
        if (context.turnState) {
          yield* turn.completeTurn(
            context,
            "interrupted",
            interruptionMessageFromClaudeCause(exit.cause),
          );
        }
      } else {
        const message = messageFromClaudeStreamCause(exit.cause, "Claude runtime stream failed.");
        yield* turn.emitRuntimeError(context, message, Cause.pretty(exit.cause));
        yield* turn.completeTurn(context, "failed", message);
      }
    } else if (context.turnState) {
      yield* turn.completeTurn(context, "interrupted", "Claude runtime stream ended.");
    }

    yield* stopSessionInternal(context, {
      emitExitEvent: true,
    });
  });

  return {
    updateResumeCursor: turn.updateResumeCursor,
    ensureAssistantTextBlock: blocks.ensureAssistantTextBlock,
    completeAssistantTextBlock: blocks.completeAssistantTextBlock,
    emitRuntimeError: turn.emitRuntimeError,
    emitRuntimeWarning: turn.emitRuntimeWarning,
    emitProposedPlanCompleted: turn.emitProposedPlanCompleted,
    completeTurn: turn.completeTurn,
    handleSdkMessage: messages.handleSdkMessage,
    runSdkStream,
    stopSessionInternal,
    handleStreamExit,
  };
};

export type StreamHandlers = ReturnType<typeof makeStreamHandlers>;
