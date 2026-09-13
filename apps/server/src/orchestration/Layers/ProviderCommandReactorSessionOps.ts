import {
  DEFAULT_SERVER_SETTINGS,
  ProviderKind,
  type ProviderSession,
  ThreadId,
} from "@bigbud/contracts";
import { Effect, Equal, Schema } from "effect";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { ProviderValidationError } from "../../provider/Errors.ts";
import { resolveDefaultChatCwd } from "../../ws/serverSettings.ts";
import { mapProviderSessionStatusToOrchestrationStatus } from "./ProviderCommandReactorHelpers.ts";
import { startProviderSession } from "./ProviderCommandReactorSessionOps.start.ts";
import {
  ongoingProviderWorkError,
  capturedModelSelectionError,
  resolveTurnExecutionSettings,
  type EnsureSessionOptions,
} from "./ProviderCommandReactorSessionOps.settings.ts";
import type {
  SendTurnForThreadInput,
  SessionOpServices,
} from "./ProviderCommandReactorSessionOps.types.ts";

import { sendTurnAttempt } from "./ProviderCommandReactorSessionOps.send.ts";
import { withOneShotContextLimitRecovery } from "./ProviderCommandReactorSessionOps.recovery.ts";

export const ensureSessionForThread = (services: SessionOpServices) =>
  Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: EnsureSessionOptions,
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
    const desiredRuntimeMode = options?.runtimeMode ?? thread.runtimeMode;
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
    const start = (input?: {
      readonly resumeCursor?: unknown;
      readonly fresh?: boolean;
      readonly preserveExistingBinding?: boolean;
    }) =>
      startProviderSession({
        services: {
          providerService,
          setThreadSession,
          assertRuntimeStartAllowed: services.assertRuntimeStartAllowed,
        },
        thread,
        threadId,
        createdAt,
        provider: preferredProvider,
        modelSelection: desiredModelSelection,
        runtimeMode: desiredRuntimeMode,
        cwd: effectiveCwd,
        ...(input?.fresh ? { fresh: true } : {}),
        ...(input?.preserveExistingBinding ? { preserveExistingBinding: true } : {}),
        ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
      });
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
        ...(session.sessionEpoch !== undefined
          ? { expectedSessionEpoch: session.sessionEpoch }
          : {}),
      });

    const activeSession = yield* resolveActiveSession(threadId);
    // Per-turn callers always supply their resolved runtime. Preserve existing
    // explicit session-reconfiguration behavior when no turn override is given.
    const ongoingWorkError =
      options?.runtimeMode !== undefined
        ? ongoingProviderWorkError(thread, activeSession)
        : undefined;
    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = desiredRuntimeMode !== activeSession?.runtimeMode;
      const providerChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.provider !== currentProvider;
      const sessionModelSwitch =
        currentProvider === undefined
          ? "in-session"
          : (yield* providerService.getCapabilities(currentProvider)).sessionModelSwitch;
      const capturedModelError = capturedModelSelectionError({
        modelSelection: desiredModelSelection,
        activeSession,
        sessionModelSwitch,
        requireExactModel: options?.requireExactModel ?? false,
      });
      if (capturedModelError) return yield* capturedModelError;
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
        // The synchronous start projection uses thread defaults. Reconcile it
        // with the reused live runtime without advancing the session epoch.
        if (activeSession && thread.session?.runtimeMode !== desiredRuntimeMode) {
          if (ongoingWorkError) return yield* ongoingWorkError;
          yield* bindSessionToThread(activeSession);
        }
        return existingSessionThreadId;
      }

      if (ongoingWorkError) return yield* ongoingWorkError;

      const resumeCursor =
        providerChanged || shouldRestartForModelChange
          ? undefined
          : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider,
        desiredProvider: desiredModelSelection.provider,
        currentRuntimeMode: activeSession?.runtimeMode,
        desiredRuntimeMode,
        runtimeModeChanged,
        providerChanged,
        modelChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* start({
        preserveExistingBinding: true,
        ...(resumeCursor !== undefined ? { resumeCursor } : {}),
      });
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

    if (ongoingWorkError) return yield* ongoingWorkError;

    const startedSession = yield* start(
      options?.restartFreshIfInactive ? { fresh: true } : undefined,
    );
    capabilityContextStates.delete(threadId);
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });

export const sendTurnForThread = (services: SessionOpServices) =>
  Effect.fn("sendTurnForThread")(function* (input: SendTurnForThreadInput) {
    const thread = yield* services.resolveThread(input.threadId);
    if (!thread) return;
    const effectiveInput = { ...input, ...resolveTurnExecutionSettings(thread, input) };
    yield* withOneShotContextLimitRecovery({
      threadId: input.threadId,
      providerService: services.providerService,
      states: services.capabilityContextStates,
      attempt: () => sendTurnAttempt(services, ensureSessionForThread(services))(effectiveInput),
    });
  });

export {
  maybeGenerateAndRenameWorktreeBranchForFirstTurn,
  maybeGenerateThreadTitleForFirstTurn,
} from "./ProviderCommandReactorSessionOps.firstTurn.ts";
