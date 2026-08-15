/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import {
  query,
  type Options as ClaudeQueryOptions,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { resolveApiModelId } from "@bigbud/shared/model";
import { DateTime, Deferred, Effect, FileSystem, Layer, Queue, Random, Stream } from "effect";

import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../../Errors.ts";
import { ClaudeAdapter, type ClaudeAdapterShape } from "../../Services/Claude/Adapter.ts";
import { unavailableActiveTurnInspection } from "../../providerActiveTurnInspection.ts";
import { makeEventNdjsonLogger } from "../EventNdjsonLogger.ts";
import type {
  PendingApprovalLedgerEntry,
  PendingUserInputLedgerEntry,
} from "./Adapter.requestLedger.ts";
import type {
  ClaudeAdapterLiveOptions,
  ClaudeQueryRuntime,
  ClaudeSessionContext,
  ClaudeTurnState,
} from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import { makeStreamHandlers } from "./Adapter.stream.ts";
import { makeBuildUserMessageEffect } from "./Adapter.session.message.ts";
import { makeStartSession } from "./Adapter.session.ts";
import { applyClaudeRuntimeTraits } from "./Adapter.session.traits.ts";
import { toRequestError } from "./Adapter.utils.ts";
import { rememberBoundedIdentity } from "./Adapter.dedup.ts";
import { makeClaudeControlOperations } from "./Adapter.controls.ts";

export type { ClaudeAdapterLiveOptions };

export const makeClaudeAdapter = Effect.fn("makeClaudeAdapter")(function* (
  options?: ClaudeAdapterLiveOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);

  const createQuery =
    options?.createQuery ??
    ((input: {
      readonly prompt: AsyncIterable<SDKUserMessage>;
      readonly options: ClaudeQueryOptions;
    }): ClaudeQueryRuntime => query({ prompt: input.prompt, options: input.options }));

  const sessions = new Map<ThreadId, ClaudeSessionContext>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const serverSettingsService = yield* ServerSettingsService;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const streamHandlers = makeStreamHandlers({
    makeEventStamp,
    offerRuntimeEvent,
    nowIso,
    sessions,
  });

  const startSession: ClaudeAdapterShape["startSession"] = makeStartSession({
    fileSystem,
    serverConfig,
    serverSettingsService,
    ...(options?.harness ? { harness: options.harness } : {}),
    ...(options?.resolveHarness ? { resolveHarness: options.resolveHarness } : {}),
    nativeEventLogger,
    createQuery,
    sessions,
    makeEventStamp,
    offerRuntimeEvent,
    nowIso,
    streamHandlers,
  });

  const buildUserMessageEffect = makeBuildUserMessageEffect({ fileSystem, serverConfig });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<ClaudeSessionContext, ProviderAdapterError> => {
    const context = sessions.get(threadId);
    if (!context) {
      return Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }
    if (context.stopped || context.session.status === "closed") {
      return Effect.fail(
        new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }
    return Effect.succeed(context);
  };

  const sendTurn: ClaudeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    const modelSelection =
      input.modelSelection?.provider === "claudeAgent" ? input.modelSelection : undefined;

    if (context.pendingApprovals.size > 0 || context.pendingUserInputs.size > 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Resolve or cancel the pending approval or user-input request first.",
      });
    }

    if (context.turnState) {
      // Auto-close a stale synthetic turn (from background agent responses
      // between user prompts) to prevent blocking the user's next turn.
      yield* streamHandlers.completeTurn(context, "completed");
    }

    if (modelSelection?.model) {
      const apiModelId = resolveApiModelId(modelSelection);
      if (context.currentApiModelId !== apiModelId) {
        yield* Effect.tryPromise({
          try: () => context.query.setModel(apiModelId),
          catch: (cause) => toRequestError(input.threadId, "turn/setModel", cause),
        });
        context.currentApiModelId = apiModelId;
      }
      context.session = {
        ...context.session,
        model: modelSelection.model,
      };
    }

    if (modelSelection) {
      yield* applyClaudeRuntimeTraits({ context, modelSelection, threadId: input.threadId });
    }

    // Apply interaction mode by switching the SDK's permission mode.
    // "plan" maps directly to the SDK's "plan" permission mode;
    // "default" restores the session's original permission mode.
    // When interactionMode is absent we leave the current mode unchanged.
    const requestedPermissionMode =
      input.interactionMode === "plan"
        ? "plan"
        : input.interactionMode === "default"
          ? (context.basePermissionMode ?? "default")
          : undefined;
    if (requestedPermissionMode && context.effectivePermissionMode !== requestedPermissionMode) {
      yield* Effect.tryPromise({
        try: () => context.query.setPermissionMode(requestedPermissionMode),
        catch: (cause) => toRequestError(input.threadId, "turn/setPermissionMode", cause),
      });
      context.effectivePermissionMode = requestedPermissionMode;
    }

    const turnId = TurnId.makeUnsafe(yield* Random.nextUUIDv4);
    const turnState: ClaudeTurnState = {
      turnId,
      startedAt: yield* nowIso,
      items: [],
      assistantTextBlocks: new Map(),
      assistantTextBlockOrder: [],
      capturedProposedPlanKeys: new Set(),
      nextSyntheticAssistantBlockIndex: -1,
    };

    const updatedAt = yield* nowIso;
    context.turnState = turnState;
    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt,
    };

    const turnStartedStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.started",
      eventId: turnStartedStamp.eventId,
      provider: PROVIDER,
      createdAt: turnStartedStamp.createdAt,
      threadId: context.session.threadId,
      turnId,
      payload: modelSelection?.model ? { model: modelSelection.model } : {},
      providerRefs: {},
    });

    const message = yield* buildUserMessageEffect(input as ProviderSendTurnInput);

    if (message.uuid) {
      rememberBoundedIdentity(context.queuedUserMessageIds, message.uuid, 500);
    }

    yield* Queue.offer(context.promptQueue, {
      type: "message",
      message,
    }).pipe(Effect.mapError((cause) => toRequestError(input.threadId, "turn/start", cause)));

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  });

  const { interruptTurn, mcp, readThread, rollbackThread } = makeClaudeControlOperations({
    requireSession,
  });

  const respondToRequest: ClaudeAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (threadId, requestId, decision) {
      const context = yield* requireSession(threadId);
      const pending = context.pendingApprovals.get(requestId);
      if (!pending) {
        const resolved = context.resolvedApprovals.get(requestId);
        if (resolved === decision) return;
        if (resolved !== undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/requestApproval/decision",
            detail: `Approval request ${requestId} was already resolved with a different decision.`,
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "item/requestApproval/decision",
          detail: `Unknown pending approval request: ${requestId}`,
        });
      }

      const ledgerEntry = context.requestLedger.get(requestId);
      if (ledgerEntry?.kind === "approval" && ledgerEntry.state === "pending") {
        (ledgerEntry as PendingApprovalLedgerEntry).uiDecision = decision;
      }

      context.pendingApprovals.delete(requestId);
      context.resolvedApprovals.set(requestId, decision);
      context.resolvedApprovalSuggestions.set(requestId, pending.suggestions ?? []);
      while (context.resolvedApprovals.size > 500) {
        const oldest = context.resolvedApprovals.keys().next().value;
        if (oldest === undefined) break;
        context.resolvedApprovals.delete(oldest);
        context.resolvedApprovalSuggestions.delete(oldest);
        context.appliedSessionPermissionRequests.delete(oldest);
      }
      yield* Deferred.succeed(pending.decision, decision);
    },
  );

  const respondToUserInput: ClaudeAdapterShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (threadId, requestId, answers) {
    const context = yield* requireSession(threadId);
    const pending = context.pendingUserInputs.get(requestId);
    if (!pending) {
      const resolved = context.resolvedUserInputs.get(requestId);
      if (resolved && JSON.stringify(resolved) === JSON.stringify(answers)) return;
      if (resolved) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "item/tool/respondToUserInput",
          detail: `User-input request ${requestId} was already resolved with different answers.`,
        });
      }
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "item/tool/respondToUserInput",
        detail: `Unknown pending user-input request: ${requestId}`,
      });
    }

    const ledgerEntry = context.requestLedger.get(requestId);
    if (ledgerEntry?.kind === "user-input" && ledgerEntry.state === "pending") {
      (ledgerEntry as PendingUserInputLedgerEntry).uiAnswers = answers;
    }

    context.pendingUserInputs.delete(requestId);
    context.resolvedUserInputs.set(requestId, answers);
    while (context.resolvedUserInputs.size > 500) {
      const oldest = context.resolvedUserInputs.keys().next().value;
      if (oldest === undefined) break;
      context.resolvedUserInputs.delete(oldest);
    }
    yield* Deferred.succeed(pending.answers, answers);
  });

  const stopSession: ClaudeAdapterShape["stopSession"] = Effect.fn("stopSession")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      yield* streamHandlers.stopSessionInternal(context, {
        emitExitEvent: true,
      });
    },
  );

  const listSessions: ClaudeAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

  const hasSession: ClaudeAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  const stopAll: ClaudeAdapterShape["stopAll"] = () =>
    Effect.forEach(
      sessions,
      ([, context]) =>
        streamHandlers.stopSessionInternal(context, {
          emitExitEvent: true,
        }),
      { discard: true },
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      sessions,
      ([, context]) =>
        streamHandlers.stopSessionInternal(context, {
          emitExitEvent: false,
        }),
      { discard: true },
    ).pipe(Effect.tap(() => Queue.shutdown(runtimeEventQueue))),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      sessionRecovery: "resume-restart",
      conversationRewind: "unsupported",
      conversationFork: "unsupported",
    },
    mcp,
    startSession,
    sendTurn,
    interruptTurn,
    inspectActiveTurn: unavailableActiveTurnInspection("claudeAgent"),
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies ClaudeAdapterShape;
});

export const ClaudeAdapterLive = Layer.effect(ClaudeAdapter, makeClaudeAdapter());

export function makeClaudeAdapterLive(options?: ClaudeAdapterLiveOptions) {
  return Layer.effect(ClaudeAdapter, makeClaudeAdapter(options));
}
