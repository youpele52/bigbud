/**
 * ProviderCommandReactor turn-level and session-level event handlers.
 *
 * Contains the per-event processing functions that are called by
 * ProviderCommandReactor.ts after events arrive from the orchestration stream.
 */
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  type ModelSelection,
  type OrchestrationSession,
  ThreadId,
  type TurnId,
} from "@bigbud/contracts";
import { buildProviderMessageText } from "@bigbud/shared/history";
import { Cache, Cause, Duration, Effect, FileSystem, Option, Scope } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import { GitStatusBroadcaster } from "../../git/Services/GitStatusBroadcaster.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { DiscoveryRegistry } from "../../provider/Services/DiscoveryRegistry.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { ProjectionThreadWatchRepository } from "../../persistence/Services/ProjectionThreadWatches.ts";
import { registerThreadWatchesFromAttachments } from "../ThreadWatch.logic.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { resolveDefaultChatCwd, ServerSettingsService } from "../../ws/serverSettings.ts";
import { ServerConfig } from "../../startup/config.ts";
import { WorkspacePaths } from "../../workspace/Services/WorkspacePaths.ts";
import {
  formatProviderServiceCauseDetail,
  HANDLED_TURN_START_KEY_MAX,
  HANDLED_TURN_START_KEY_TTL_MINUTES,
  resolveThreadTitleSeed,
  serverCommandId,
} from "./ProviderCommandReactorHelpers.ts";
import { shouldAllowAutoTitleReplace } from "../../orchestration-tools/ThreadTitleLock.ts";
import { appendFileAttachmentsToProviderInput } from "./ProviderCommandReactorHandlers.attachments.ts";
import { makeProcessDeletionRequested } from "./ProviderCommandReactorHandlers.delete.ts";
import { maybeGenerateThreadElevatorSummary } from "./ProviderCommandReactorHandlers.elevatorSummary.ts";
import { makeProcessProjectDeletionRequested } from "./ProviderCommandReactorHandlers.project-delete.ts";
import { makeProcessSessionHandlers } from "./ProviderCommandReactorHandlers.session.ts";
import { expandProviderInputMentions } from "./ProviderCommandReactorInputExpansion.ts";
import {
  ensureSessionForThread,
  maybeGenerateAndRenameWorktreeBranchForFirstTurn,
  maybeGenerateThreadTitleForFirstTurn,
  sendTurnForThread,
  type SessionOpServices,
} from "./ProviderCommandReactorSessionOps.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";

type ProviderIntentEvent = Extract<
  import("@bigbud/contracts").OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.message-sent"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested"
      | "thread.deletion-requested"
      | "project.deletion-requested";
  }
>;

export const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

export type ProviderCommandHandlers =
  typeof makeProviderCommandHandlers extends Effect.Effect<infer A, any, any> ? A : never;

export const makeProviderCommandHandlers = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const discoveryRegistry = yield* DiscoveryRegistry;
  const git = yield* GitCore;
  const gitStatusBroadcaster = yield* GitStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const serverConfig = yield* ServerConfig;
  const workspacePaths = yield* WorkspacePaths;
  const fileSystem = yield* FileSystem.FileSystem;
  const threadWatchRepository = yield* ProjectionThreadWatchRepository;
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: Duration.minutes(HANDLED_TURN_START_KEY_TTL_MINUTES),
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("provider-failure-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: input.kind,
        summary: input.summary,
        payload: {
          detail: input.detail,
          ...(input.requestId ? { requestId: input.requestId } : {}),
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    orchestrationEngine
      .dispatch({
        type: "thread.session.set",
        commandId: serverCommandId("provider-session-set"),
        threadId: input.threadId,
        session: input.session,
        createdAt: input.createdAt,
      })
      .pipe(Effect.asVoid);

  const resolveThread = Effect.fn("resolveThread")(function* (threadId: ThreadId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    return readModel.threads.find((entry) => entry.id === threadId);
  });

  const resolveProject = Effect.fn("resolveProject")(function* (
    projectId: import("@bigbud/contracts").ProjectId,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    return readModel.projects.find((entry) => entry.id === projectId);
  });

  const resolveThreadsByProject = Effect.fn("resolveThreadsByProject")(function* (
    projectId: import("@bigbud/contracts").ProjectId,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    return readModel.threads.filter((entry) => entry.projectId === projectId);
  });

  const sessionOpServices: SessionOpServices = {
    orchestrationEngine,
    providerService,
    git,
    gitStatusBroadcaster,
    textGeneration,
    serverSettingsService,
    serverConfig,
    threadModelSelections,
    setThreadSession,
    resolveThread,
  };
  const processDeletionRequested = yield* makeProcessDeletionRequested;
  const processProjectDeletionRequested = yield* makeProcessProjectDeletionRequested;
  const processSessionHandlers = makeProcessSessionHandlers({
    providerService,
    appendProviderFailureActivity,
    resolveThread,
    setThreadSession,
  });

  const expandTurnMessageText = expandProviderInputMentions({
    discoveryRegistry,
    fileSystem,
    workspacePaths,
    resolveDefaultChatCwd: () =>
      serverSettingsService.getSettings.pipe(
        Effect.map(resolveDefaultChatCwd),
        Effect.catch(() => Effect.succeed(resolveDefaultChatCwd(DEFAULT_SERVER_SETTINGS))),
      ),
  });

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    const isFirstUserMessageTurn =
      thread.messages.filter((entry) => entry.role === "user").length === 1;
    const workspaceCwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: (yield* orchestrationEngine.getReadModel()).projects,
      }) ?? undefined;
    const expandedProviderInput = yield* expandTurnMessageText({
      messageText: message.text,
      thread,
      ...(workspaceCwd ? { workspaceRoot: workspaceCwd } : {}),
    });
    const providerMessageText = buildProviderMessageText({
      text: expandedProviderInput,
      replyTo: message.replyTo ?? event.payload.replyTo,
    });
    const providerInputText = appendFileAttachmentsToProviderInput(
      providerMessageText,
      message.attachments ?? [],
    );

    if (isFirstUserMessageTurn) {
      const serverSettings = yield* serverSettingsService.getSettings.pipe(
        Effect.catch(() => Effect.succeed(DEFAULT_SERVER_SETTINGS)),
      );
      const resolvedTitleSeed = resolveThreadTitleSeed({
        currentTitle: thread.title,
        messageText: message.text,
        ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
      });
      const generationCwd =
        resolveThreadWorkspaceCwd({
          thread,
          projects: (yield* orchestrationEngine.getReadModel()).projects,
        }) ?? resolveDefaultChatCwd(serverSettings);
      const generationInput = {
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(resolvedTitleSeed !== undefined ? { titleSeed: resolvedTitleSeed } : {}),
      };

      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn(sessionOpServices)({
        threadId: event.payload.threadId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        ...generationInput,
      }).pipe(Effect.forkScoped);

      if (
        shouldAllowAutoTitleReplace({
          threadId: event.payload.threadId,
          currentTitle: thread.title,
          ...(resolvedTitleSeed !== undefined ? { titleSeed: resolvedTitleSeed } : {}),
        })
      ) {
        if (resolvedTitleSeed !== undefined && thread.title.trim() !== resolvedTitleSeed.trim()) {
          yield* orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId: serverCommandId("thread-title-seed"),
            threadId: event.payload.threadId,
            title: resolvedTitleSeed,
          });
        }

        // Fall back to the thread's own modelSelection when the turn-start event doesn't
        // carry one (e.g. Pi, where the thread is already bound to a provider).
        const titleModelSelection = event.payload.modelSelection ?? thread.modelSelection;
        yield* maybeGenerateThreadTitleForFirstTurn(sessionOpServices)({
          threadId: event.payload.threadId,
          cwd: generationCwd,
          modelSelection: titleModelSelection,
          ...generationInput,
        }).pipe(Effect.forkScoped);
      }
    }

    const threadAttachments = message.attachments ?? [];
    if (threadAttachments.some((attachment) => attachment.type === "thread")) {
      yield* registerThreadWatchesFromAttachments({
        repository: threadWatchRepository,
        watcherThreadId: event.payload.threadId,
        sourceMessageId: event.payload.messageId,
        attachments: threadAttachments,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to register thread watches from attachments", {
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }

    yield* sendTurnForThread(sessionOpServices)({
      threadId: event.payload.threadId,
      messageText: message.text,
      providerInputText,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      interactionMode: event.payload.interactionMode,
      ...(event.payload.bootstrapSourceThreadId !== undefined
        ? { bootstrapSourceThreadId: event.payload.bootstrapSourceThreadId }
        : {}),
      createdAt: event.payload.createdAt,
    }).pipe(
      Effect.catchCause((cause) =>
        appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.start.failed",
          summary: "Provider turn start failed",
          detail: formatProviderServiceCauseDetail(cause),
          turnId: null,
          createdAt: event.payload.createdAt,
        }),
      ),
    );
  });

  const {
    processApprovalResponseRequested,
    processSessionStopRequested,
    processTurnInterruptRequested,
    processUserInputResponseRequested,
  } = processSessionHandlers;

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ): Effect.fn.Return<void, ProviderServiceError | OrchestrationDispatchError, Scope.Scope> {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      ...("threadId" in event.payload
        ? { "orchestration.thread_id": event.payload.threadId }
        : { "orchestration.project_id": event.payload.projectId }),
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        yield* ensureSessionForThread(sessionOpServices)(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        );
        return;
      }
      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event);
        return;
      case "thread.message-sent":
        if (event.payload.streaming) {
          return;
        }
        yield* maybeGenerateThreadElevatorSummary(sessionOpServices)({
          threadId: event.payload.threadId,
        }).pipe(Effect.forkScoped);
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
      case "thread.deletion-requested":
        yield* processDeletionRequested(
          {
            resolveThread,
            setThreadSession,
          },
          event,
        );
        return;
      case "project.deletion-requested":
        yield* processProjectDeletionRequested(
          {
            resolveProject,
            resolveThreadsByProject,
          },
          event,
        );
        return;
    }
  });

  return {
    processDomainEvent,
  };
});
