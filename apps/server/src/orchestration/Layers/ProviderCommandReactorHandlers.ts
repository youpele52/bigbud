import { DEFAULT_SERVER_SETTINGS, type ModelSelection } from "@bigbud/contracts";
import { buildProviderMessageText } from "@bigbud/shared/history";
import { Cache, Cause, Duration, Effect, FileSystem, Path, Scope } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import { GitStatusBroadcaster } from "../../git/Services/GitStatusBroadcaster.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { DiscoveryRegistry } from "../../provider/Services/DiscoveryRegistry.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { ProjectionThreadWatchRepository } from "../../persistence/Services/ProjectionThreadWatches.ts";
import { makeThreadDelegationRepository } from "../../persistence/Layers/ThreadDelegations.ts";
import { registerThreadWatchesFromAttachments } from "../ThreadWatch.logic.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { resolveDefaultChatCwd, ServerSettingsService } from "../../ws/serverSettings.ts";
import { ServerConfig } from "../../startup/config.ts";
import { WorkspacePaths } from "../../workspace/Services/WorkspacePaths.ts";
import {
  HANDLED_TURN_START_KEY_MAX,
  HANDLED_TURN_START_KEY_TTL_MINUTES,
  resolveThreadTitleSeed,
  serverCommandId,
} from "./ProviderCommandReactorHelpers.ts";
import { shouldAllowAutoTitleReplace } from "../../orchestration-tools/ThreadTitleLock.ts";
import { threadTitleOwner } from "../../orchestration-tools/TerminalThreadTitle.ts";
import { appendFileAttachmentsToProviderInput } from "./ProviderCommandReactorHandlers.attachments.ts";
import { makeProcessDeletionRequested } from "./ProviderCommandReactorHandlers.delete.ts";
import { maybeGenerateThreadElevatorSummary } from "./ProviderCommandReactorHandlers.elevatorSummary.ts";
import { makeProcessProjectDeletionRequested } from "./ProviderCommandReactorHandlers.project-delete.ts";
import { makeProcessSessionHandlers } from "./ProviderCommandReactorHandlers.session.ts";
import {
  makeSweepSubagentsAfterInterrupt,
  withSubagentSweepAfterInterrupt,
} from "./ProviderCommandReactorHandlers.subagentSweep.ts";
import { makeProcessTurnSteerRequested } from "./ProviderCommandReactorHandlers.steer.ts";
import { makeProviderFailureHandlers } from "./ProviderCommandReactorHandlers.failures.ts";
import { makeProviderCommandProjectResolvers } from "./ProviderCommandReactorHandlers.projects.ts";
import { expandProviderInputMentions } from "./ProviderCommandReactorInputExpansion.ts";
import {
  maybeGenerateAndRenameWorktreeBranchForFirstTurn,
  maybeGenerateThreadTitleForFirstTurn,
  sendTurnForThread,
} from "./ProviderCommandReactorSessionOps.ts";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import {
  createEffectiveCapabilityCatalog,
  setEffectiveCapabilityCatalog,
} from "../../capabilities/CapabilityCatalog.dynamic.ts";
import {
  restoreProviderCapabilityContextState,
  saveProviderCapabilityContextState,
} from "./ProviderCapabilityContextPersistence.ts";
import { readProviderMemoryContext } from "./ProviderTurnMemoryContext.ts";
import { makeExecutionTargetReconfigureHandler } from "./ProviderCommandReactorHandlers.reconfigure.ts";
import {
  markTurnStartHandled,
  annotateProviderIntentEvent,
  turnStartKeyForEvent,
  type ProviderIntentEvent,
} from "./ProviderCommandReactorHandlers.events.ts";
import { makeProviderCommandSessionStateHelpers } from "./ProviderCommandReactorHandlers.sessionState.ts";
import { makeHandleTurnStartFailure } from "./ProviderCommandReactorHandlers.turnStart.ts";
import { makeRequestAutomaticFork } from "./ProviderCommandReactorHandlers.fork.ts";
import { makeTextGenerationActivityHandler } from "./ProviderCommandReactorHandlers.textGeneration.ts";
import { processRuntimeModeSet } from "./ProviderCommandReactorHandlers.runtimeMode.ts";

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
  const path = yield* Path.Path;
  const threadWatchRepository = yield* ProjectionThreadWatchRepository;
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: Duration.minutes(HANDLED_TURN_START_KEY_TTL_MINUTES),
    lookup: () => Effect.succeed(true),
  });

  const threadModelSelections = new Map<string, ModelSelection>();
  const capabilityContextStates = new Map<
    string,
    import("./ProviderCommandReactorSessionOps.capabilityContext.ts").ProviderCapabilityContextState
  >();
  const { appendProviderFailureActivity, recordTurnStartFailure } =
    makeProviderFailureHandlers(orchestrationEngine);
  const handleTurnStartFailure = makeHandleTurnStartFailure({
    orchestrationEngine,
    providerService,
    recordTurnStartFailure,
    requestAutomaticFork: makeRequestAutomaticFork({ orchestrationEngine, providerService }),
  });

  const { assertRuntimeStartAllowed, resolveThread, setThreadSession } =
    makeProviderCommandSessionStateHelpers(orchestrationEngine);

  const { resolveProject, resolveThreadsByProject } =
    makeProviderCommandProjectResolvers(orchestrationEngine);
  const sessionOpServices: SessionOpServices = {
    threadDelegationRepository: yield* makeThreadDelegationRepository,
    orchestrationEngine,
    providerService,
    git,
    gitStatusBroadcaster,
    textGeneration,
    serverSettingsService,
    serverConfig,
    threadModelSelections,
    capabilityContextStates,
    setThreadSession,
    assertRuntimeStartAllowed,
    resolveThread,
  };
  const processDeletionRequested = yield* makeProcessDeletionRequested;
  const processProjectDeletionRequested = yield* makeProcessProjectDeletionRequested;
  const processSessionHandlers = makeProcessSessionHandlers({
    orchestrationEngine,
    providerService,
    appendProviderFailureActivity,
    resolveThread,
    setThreadSession,
  });
  const processTurnSteerRequested = makeProcessTurnSteerRequested({
    providerService,
    orchestrationEngine,
    resolveThread: orchestrationEngine.getReadModel,
    appendProviderFailureActivity,
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
    if (yield* markTurnStartHandled(handledTurnStartKeys, key)) {
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      const detail = `User message '${event.payload.messageId}' was not found for turn start request.`;
      yield* recordTurnStartFailure({
        threadId: event.payload.threadId,
        context: "message-validation",
        detail,
        failureClass: "invalid-request",
        createdAt: event.payload.createdAt,
        messageId: event.payload.messageId,
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
    const effectiveCapabilityCatalog = createEffectiveCapabilityCatalog({
      discovery: yield* discoveryRegistry.getCatalog,
      thread,
    });
    setEffectiveCapabilityCatalog(thread.id, effectiveCapabilityCatalog);
    const memoryContext = yield* readProviderMemoryContext({
      fileSystem,
      path,
      stateDir: serverConfig.stateDir,
      projectId: thread.projectId,
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
          titleOwner: threadTitleOwner(thread),
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

    yield* restoreProviderCapabilityContextState({
      states: capabilityContextStates,
      fileSystem,
      path,
      stateDir: serverConfig.stateDir,
      threadId: event.payload.threadId,
    });

    yield* sendTurnForThread(sessionOpServices)({
      threadId: event.payload.threadId,
      requestMessageId: event.payload.messageId,
      messageText: message.text,
      providerInputText,
      capabilityCatalog: effectiveCapabilityCatalog,
      memoryContext,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      runtimeMode: event.payload.runtimeMode,
      interactionMode: event.payload.interactionMode,
      ...(event.payload.bootstrapSourceThreadId !== undefined
        ? { bootstrapSourceThreadId: event.payload.bootstrapSourceThreadId }
        : {}),
      createdAt: event.payload.createdAt,
    }).pipe(Effect.catchCause((cause) => handleTurnStartFailure({ event, message, cause })));
    yield* saveProviderCapabilityContextState({
      states: capabilityContextStates,
      fileSystem,
      path,
      stateDir: serverConfig.stateDir,
      threadId: event.payload.threadId,
    });
  });

  const {
    processApprovalResponseRequested,
    processSessionStopRequested,
    processUserInputResponseRequested,
  } = processSessionHandlers;
  const processTurnInterruptRequested = withSubagentSweepAfterInterrupt({
    resolveThread,
    sweep: makeSweepSubagentsAfterInterrupt({
      orchestrationEngine,
      providerService,
      resolveThread,
    }),
    processTurnInterruptRequested: processSessionHandlers.processTurnInterruptRequested,
  });

  const processExecutionTargetReconfigure =
    makeExecutionTargetReconfigureHandler(sessionOpServices);
  const processTextGenerationActivity = yield* makeTextGenerationActivityHandler(sessionOpServices);
  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ): Effect.fn.Return<void, ProviderServiceError | OrchestrationDispatchError, Scope.Scope> {
    yield* annotateProviderIntentEvent(event);
    switch (event.type) {
      case "thread.activity-appended":
        return yield* processTextGenerationActivity(event);
      case "thread.runtime-mode-set":
        return yield* processRuntimeModeSet(sessionOpServices, event);
      case "thread.meta-updated":
        yield* processExecutionTargetReconfigure(event);
        return;
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
      case "thread.turn-steer-requested":
        yield* processTurnSteerRequested(event);
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
    processTextGenerationActivity,
    processDomainEvent,
  };
});
