import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  ProviderKind,
  type ProviderSession,
  ThreadId,
} from "@bigbud/contracts";
import { Effect, Equal, Schema } from "effect";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { BIGBUD_CAPABILITY_CATALOG } from "../../capabilities/BigbudCapabilityTracks.ts";
import { resolveProviderSessionExecutionTargets } from "../../provider/providerSessionExecutionTargets.ts";
import { ProviderValidationError } from "../../provider/Errors.ts";
import { resolveDefaultChatCwd } from "../../ws/serverSettings.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import {
  buildResumedTurnInput,
  mapProviderSessionStatusToOrchestrationStatus,
  toNonEmptyProviderInput,
} from "./ProviderCommandReactorHelpers.ts";
import {
  maybeGenerateAndRenameWorktreeBranchForFirstTurn,
  maybeGenerateThreadTitleForFirstTurn,
} from "./ProviderCommandReactorSessionOps.firstTurn.ts";
import {
  appendReferencedThreadsToProviderInput,
  prependThreadContextToProviderInput,
  resolveAndExportThreadContextPath,
} from "./ProviderCommandReactorSessionOps.threadContext.ts";
import { shouldRebuildProviderContextFromTranscript } from "./ProviderCommandReactorSessionOps.context.ts";
import { prependCapabilityContextToProviderInput } from "./ProviderCommandReactorSessionOps.capabilityContext.ts";
import {
  rolloverProviderSessionAtHighWater,
  withOneShotContextLimitRecovery,
} from "./ProviderCommandReactorSessionOps.recovery.ts";
import type {
  SendTurnForThreadInput,
  SessionOpServices,
} from "./ProviderCommandReactorSessionOps.types.ts";
export type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";

export const ensureSessionForThread = (services: SessionOpServices) =>
  Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly restartFreshIfInactive?: boolean;
    },
  ) {
    const {
      orchestrationEngine,
      providerService,
      threadModelSelections,
      capabilityContextStates,
      setThreadSession,
    } = services;

    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const currentProvider: import("@bigbud/contracts").ProviderKind | undefined = Schema.is(
      ProviderKind,
    )(thread.session?.providerName)
      ? thread.session.providerName
      : undefined;
    const requestedModelSelection = options?.modelSelection;
    const threadProvider: import("@bigbud/contracts").ProviderKind =
      currentProvider ?? thread.modelSelection.provider;
    const preferredProvider: import("@bigbud/contracts").ProviderKind =
      requestedModelSelection !== undefined && requestedModelSelection.provider !== threadProvider
        ? requestedModelSelection.provider
        : (currentProvider ?? threadProvider);
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    if (
      requestedModelSelection !== undefined &&
      requestedModelSelection.provider !== threadProvider
    ) {
      return yield* new ProviderValidationError({
        operation: "ProviderCommandReactor.ensureSessionForThread",
        issue: `Thread '${threadId}' cannot switch to '${requestedModelSelection.provider}' while bound to '${threadProvider}'.`,
      });
    }
    const serverSettings = yield* services.serverSettingsService.getSettings.pipe(
      Effect.catch(() => Effect.succeed(DEFAULT_SERVER_SETTINGS)),
    );
    const effectiveCwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: readModel.projects,
      }) ?? resolveDefaultChatCwd(serverSettings);

    const resolveActiveSession = (tId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === tId)));

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: import("@bigbud/contracts").ProviderKind;
      readonly fresh?: boolean;
    }) => {
      const executionTargets = resolveProviderSessionExecutionTargets({
        providerRuntimeExecutionTargetId: thread.providerRuntimeExecutionTargetId,
        workspaceExecutionTargetId: thread.workspaceExecutionTargetId,
        executionTargetId: thread.executionTargetId,
      });
      return (input?.fresh ? providerService.startSessionFresh : providerService.startSession)(
        threadId,
        {
          threadId,
          ...(preferredProvider ? { provider: preferredProvider } : {}),
          ...executionTargets,
          ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
          modelSelection: desiredModelSelection,
          ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
          runtimeMode: desiredRuntimeMode,
        },
      );
    };

    const bindSessionToThread = (session: ProviderSession) =>
      setThreadSession({
        threadId,
        session: {
          threadId,
          status: mapProviderSessionStatusToOrchestrationStatus(session.status),
          providerName: session.provider,
          runtimeMode: desiredRuntimeMode,
          activeTurnId: null,
          lastError: session.lastError ?? null,
          updatedAt: session.updatedAt,
        },
        createdAt,
      });

    const activeSession = yield* resolveActiveSession(threadId);
    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const providerChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.provider !== currentProvider;
      if (!activeSession && options?.restartFreshIfInactive) {
        const restartedSession = yield* startProviderSession({ fresh: true });
        capabilityContextStates.delete(threadId);
        yield* bindSessionToThread(restartedSession);
        return restartedSession.threadId;
      }
      const sessionModelSwitch =
        currentProvider === undefined
          ? "in-session"
          : (yield* providerService.getCapabilities(currentProvider)).sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "restart-session";
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        currentProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);

      if (
        !runtimeModeChanged &&
        !providerChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        return existingSessionThreadId;
      }

      const resumeCursor =
        providerChanged || shouldRestartForModelChange
          ? undefined
          : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider,
        desiredProvider: desiredModelSelection.provider,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        providerChanged,
        modelChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      capabilityContextStates.delete(threadId);
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
      });
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    const startedSession = yield* startProviderSession(
      options?.restartFreshIfInactive ? { fresh: true } : undefined,
    );
    capabilityContextStates.delete(threadId);
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });

const sendTurnAttempt = (services: SessionOpServices) =>
  Effect.fn("sendTurnAttempt")(function* (input: SendTurnForThreadInput) {
    const { providerService, setThreadSession, threadModelSelections, resolveThread } = services;
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    const bootstrapThread =
      input.bootstrapSourceThreadId !== undefined
        ? ((yield* resolveThread(input.bootstrapSourceThreadId)) ?? null)
        : null;
    if (input.bootstrapSourceThreadId !== undefined) {
      if (!bootstrapThread) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: "thread.turn.start",
          detail: `Bootstrap source thread '${input.bootstrapSourceThreadId}' does not exist.`,
        });
      }
      if (bootstrapThread.projectId !== thread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: "thread.turn.start",
          detail: `Bootstrap source thread '${input.bootstrapSourceThreadId}' must belong to project '${thread.projectId}'.`,
        });
      }
    }
    const normalizedAttachments = input.attachments ?? [];
    let activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    activeSession = yield* rolloverProviderSessionAtHighWater({
      providerService,
      states: services.capabilityContextStates,
      threadId: input.threadId,
      activeSession,
      activities: thread.activities,
    });
    const shouldBootstrapFromTranscript = shouldRebuildProviderContextFromTranscript({
      thread,
      bootstrapThread,
      activeSession,
      messageText: input.messageText,
      attachments: normalizedAttachments,
    });

    yield* ensureSessionForThread(services)(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      restartFreshIfInactive: shouldBootstrapFromTranscript,
    });
    activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }

    yield* resolveAndExportThreadContextPath({
      thread,
      stateDir: services.serverConfig.stateDir,
    });

    const baseInput = shouldBootstrapFromTranscript
      ? buildResumedTurnInput({
          transcriptThread: bootstrapThread ?? thread,
          latestTranscriptMessageText: input.messageText,
          latestProviderInputText: input.providerInputText ?? input.messageText,
        })
      : (input.providerInputText ?? input.messageText);
    const capabilityContextEnabled =
      process.env.BIGBUD_CAPABILITY_CONTEXT_ENABLED?.trim().toLowerCase() !== "false";
    const serverSettings = yield* services.serverSettingsService.getSettings.pipe(
      Effect.catch(() => Effect.succeed(DEFAULT_SERVER_SETTINGS)),
    );
    const providerInputWithCurrentThread = capabilityContextEnabled
      ? prependCapabilityContextToProviderInput({
          providerInputText: baseInput,
          catalog: input.capabilityCatalog ?? BIGBUD_CAPABILITY_CATALOG,
          thread,
          ...(activeSession?.provider ? { provider: activeSession.provider } : {}),
          ...(activeSession?.model ? { model: activeSession.model } : {}),
          memoryContext: input.memoryContext ?? "",
          agentBrowserPreference: serverSettings.agentBrowserPreference,
          contextRole: bootstrapThread
            ? "branch"
            : thread.parentThread
              ? "delegated-child"
              : "main",
          states: services.capabilityContextStates,
        })
      : prependThreadContextToProviderInput({
          providerInputText:
            input.memoryContext && input.memoryContext.length > 0
              ? `Relevant persistent bigbud memory:\n${input.memoryContext}\n\n${baseInput}`
              : baseInput,
          threadId: thread.id,
          threadTitle: thread.title,
          computerUseEnabled: serverSettings.computerUseEnabled,
          agentBrowserPreference: serverSettings.agentBrowserPreference,
          serverMode: services.serverConfig.mode,
        });
    const providerInputWithReferencedThreads = yield* appendReferencedThreadsToProviderInput({
      providerInputText: providerInputWithCurrentThread ?? "",
      currentThreadId: thread.id,
      attachments: normalizedAttachments,
      resolveThread,
    });
    const normalizedInput = toNonEmptyProviderInput(providerInputWithReferencedThreads);
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : (yield* providerService.getCapabilities(activeSession.provider)).sessionModelSwitch;
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported"
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    const providerAttachments = normalizedAttachments.filter(
      (attachment) => attachment.type !== "thread",
    );
    const sessionBeforeTurn = (yield* resolveThread(input.threadId))?.session ?? null;
    const turn = yield* providerService.sendTurn({
      threadId: input.threadId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(providerAttachments.length > 0 ? { attachments: providerAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    });

    const sessionAfterTurn = (yield* resolveThread(input.threadId))?.session ?? null;
    const sessionUnchangedSinceSend =
      sessionBeforeTurn !== null &&
      sessionAfterTurn !== null &&
      sessionAfterTurn.status === sessionBeforeTurn.status &&
      sessionAfterTurn.activeTurnId === sessionBeforeTurn.activeTurnId &&
      sessionAfterTurn.updatedAt === sessionBeforeTurn.updatedAt &&
      sessionAfterTurn.providerName === sessionBeforeTurn.providerName &&
      sessionAfterTurn.runtimeMode === sessionBeforeTurn.runtimeMode;

    if (sessionAfterTurn === null || sessionUnchangedSinceSend) {
      yield* setThreadSession({
        threadId: input.threadId,
        session: {
          threadId: input.threadId,
          status: "running",
          providerName:
            sessionAfterTurn?.providerName ??
            sessionBeforeTurn?.providerName ??
            thread.modelSelection.provider,
          runtimeMode:
            sessionAfterTurn?.runtimeMode ?? sessionBeforeTurn?.runtimeMode ?? thread.runtimeMode,
          activeTurnId: turn.turnId,
          reason: null,
          lastError: null,
          updatedAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
    }
  });

export const sendTurnForThread = (services: SessionOpServices) =>
  Effect.fn("sendTurnForThread")(function* (input: SendTurnForThreadInput) {
    yield* withOneShotContextLimitRecovery({
      threadId: input.threadId,
      providerService: services.providerService,
      states: services.capabilityContextStates,
      attempt: () => sendTurnAttempt(services)(input),
    });
  });

export { maybeGenerateAndRenameWorktreeBranchForFirstTurn, maybeGenerateThreadTitleForFirstTurn };
