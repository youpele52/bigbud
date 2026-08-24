/**
 * ClaudeAdapter stream - session lifecycle and factory wiring.
 *
 * This module is the entry point for stream handling. It wires together
 * block, turn, and message handler sub-modules into a single `makeStreamHandlers`
 * factory that preserves the original closure-based session semantics.
 *
 * @module ClaudeAdapter.stream
 */
import { type EventId, ThreadId } from "@bigbud/contracts";
import { Cause, Deferred, Effect, Exit, Fiber, Queue, Stream } from "effect";

import { ProviderAdapterProcessError } from "../../Errors.ts";
import {
  interruptionMessageFromClaudeCause,
  isClaudeInterruptedCause,
  messageFromClaudeStreamCause,
  toError,
} from "./Adapter.utils.ts";
import type { ClaudeSessionContext, UnstampedProviderRuntimeEvent } from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import { makeBlockHandlers } from "./Adapter.stream.blocks.ts";
import { makeTurnHandlers } from "./Adapter.stream.turn.ts";
import { makeMessageHandlers } from "./Adapter.stream.handlers.ts";

/** Shared dependencies injected into all stream handler functions. */
export interface StreamHandlerDeps {
  readonly makeEventStamp: () => Effect.Effect<{
    eventId: EventId;
    createdAt: string;
  }>;
  readonly offerRuntimeEvent: (event: UnstampedProviderRuntimeEvent) => Effect.Effect<void>;
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

    for (const pending of context.pendingApprovals.values()) {
      yield* Deferred.succeed(pending.decision, "cancel");
    }
    context.pendingApprovals.clear();

    for (const pending of context.pendingUserInputs.values()) {
      pending.cancelled = true;
      yield* Deferred.succeed(pending.answers, {});
    }
    context.pendingUserInputs.clear();

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
    if (context.cleanupRemoteWorkspaceBridge) {
      const cleanupBridge = Effect.tryPromise({
        try: () => context.cleanupRemoteWorkspaceBridge?.() ?? Promise.resolve(),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: context.session.threadId,
            detail:
              cause instanceof Error && cause.message.length > 0
                ? cause.message
                : "Failed to clean up Claude remote workspace bridge.",
            cause,
          }),
      }).pipe(
        Effect.catch((cause) =>
          turn.emitRuntimeError(
            context,
            "Failed to clean up Claude remote workspace bridge.",
            cause.cause ?? cause,
          ),
        ),
        Effect.ignore,
      );
      yield* cleanupBridge;
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
        const recovery = context.recoverStream;
        if (recovery) {
          const recovered = yield* Effect.matchEffect(recovery(), {
            onFailure: () => Effect.succeed(false),
            onSuccess: () => Effect.succeed(true),
          });
          if (recovered) {
            return;
          }
        }
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
