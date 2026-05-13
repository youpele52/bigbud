/**
 * Session-level operations for ProviderCommandReactor.
 *
 * Contains ensureSessionForThread, sendTurnForThread, and first-turn
 * enrichment helpers (branch rename, thread title generation).
 * All functions accept service objects as explicit parameters so they
 * can be extracted from the Effect.gen factory in Handlers.
 */
import {
  type ChatAttachment,
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type OrchestrationMessage,
  type OrchestrationSession,
  ProviderKind,
  type OrchestrationThread,
  ThreadId,
  type ProviderSession,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "@bigbud/contracts";
import { buildBootstrapInput, hasAnyAttachments } from "@bigbud/shared/history";
import { Cause, Effect, Equal, Schema } from "effect";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import type { GitCoreShape } from "../../git/Services/GitCore.ts";
import type { GitStatusBroadcasterShape } from "../../git/Services/GitStatusBroadcaster.ts";
import type { TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import { ProviderValidationError } from "../../provider/Errors.ts";
import { resolveDefaultChatCwd, type ServerSettingsShape } from "../../ws/serverSettings.ts";
import { OrchestrationCommandInvariantError, type OrchestrationDispatchError } from "../Errors.ts";
import {
  buildGeneratedWorktreeBranchName,
  canReplaceThreadTitle,
  isTemporaryWorktreeBranch,
  mapProviderSessionStatusToOrchestrationStatus,
  serverCommandId,
  toNonEmptyProviderInput,
} from "./ProviderCommandReactorHelpers.ts";

/** Service bundle accepted by session-op helpers. */
export type SessionOpServices = {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly providerService: ProviderServiceShape;
  readonly git: GitCoreShape;
  readonly gitStatusBroadcaster: GitStatusBroadcasterShape;
  readonly textGeneration: TextGenerationShape;
  readonly serverSettingsService: ServerSettingsShape;
  readonly threadModelSelections: Map<string, ModelSelection>;
  readonly setThreadSession: (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) => Effect.Effect<void, OrchestrationDispatchError>;
  readonly resolveThread: (threadId: ThreadId) => Effect.Effect<OrchestrationThread | undefined>;
};

function shouldRebuildProviderContextFromTranscript(input: {
  readonly thread: OrchestrationThread;
  readonly bootstrapThread: OrchestrationThread | null;
  readonly activeSession: ProviderSession | undefined;
  readonly messageText: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}): boolean {
  if (input.bootstrapThread) {
    return input.bootstrapThread.messages.length > 0 && !hasAnyAttachments(input.attachments);
  }
  if (input.activeSession) {
    return false;
  }
  if (input.thread.messages.length <= 1) {
    return false;
  }
  if (hasAnyAttachments(input.attachments)) {
    return false;
  }
  return true;
}

function buildResumedTurnInput(input: {
  readonly transcriptThread: OrchestrationThread;
  readonly latestTranscriptMessageText: string;
  readonly latestProviderInputText: string;
}): string {
  const previousMessages = input.transcriptThread.messages.filter(
    (message): message is OrchestrationMessage => message.role !== "system",
  );
  const transcriptMessages =
    previousMessages.at(-1)?.role === "user" &&
    previousMessages.at(-1)?.text === input.latestTranscriptMessageText
      ? previousMessages.slice(0, -1)
      : previousMessages;
  return buildBootstrapInput(
    transcriptMessages,
    input.latestProviderInputText,
    PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ).text;
}

export const ensureSessionForThread = (services: SessionOpServices) =>
  Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly restartFreshIfInactive?: boolean;
    },
  ) {
    const { orchestrationEngine, providerService, threadModelSelections, setThreadSession } =
      services;

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
    }) =>
      (input?.fresh ? providerService.startSessionFresh : providerService.startSession)(threadId, {
        threadId,
        ...(preferredProvider ? { provider: preferredProvider } : {}),
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        modelSelection: desiredModelSelection,
        ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        runtimeMode: desiredRuntimeMode,
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
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });

export const sendTurnForThread = (services: SessionOpServices) =>
  Effect.fn("sendTurnForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly providerInputText?: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    readonly bootstrapSourceThreadId?: ThreadId;
    readonly createdAt: string;
  }) {
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
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
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
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }

    const normalizedInput = toNonEmptyProviderInput(
      shouldBootstrapFromTranscript
        ? buildResumedTurnInput({
            transcriptThread: bootstrapThread ?? thread,
            latestTranscriptMessageText: input.messageText,
            latestProviderInputText: input.providerInputText ?? input.messageText,
          })
        : (input.providerInputText ?? input.messageText),
    );
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

    const sessionBeforeTurn = (yield* resolveThread(input.threadId))?.session ?? null;
    const turn = yield* providerService.sendTurn({
      threadId: input.threadId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
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

export const maybeGenerateAndRenameWorktreeBranchForFirstTurn = (services: SessionOpServices) =>
  Effect.fn("maybeGenerateAndRenameWorktreeBranchForFirstTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    const {
      git,
      textGeneration,
      serverSettingsService,
      orchestrationEngine,
      gitStatusBroadcaster,
    } = services;
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const { textGenerationModelSelection: modelSelection } =
        yield* serverSettingsService.getSettings;

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* git.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      yield* gitStatusBroadcaster.refreshLocalStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

export const maybeGenerateThreadTitleForFirstTurn = (services: SessionOpServices) =>
  Effect.fn("maybeGenerateThreadTitleForFirstTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection: ModelSelection;
    readonly titleSeed?: string;
  }) {
    const { textGeneration, orchestrationEngine, resolveThread } = services;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const generated = yield* textGeneration.generateThreadTitle({
        cwd: input.cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection: input.modelSelection,
      });
      if (!generated) return;

      const thread = yield* resolveThread(input.threadId);
      if (!thread) return;
      if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
        return;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: serverCommandId("thread-title-rename"),
        threadId: input.threadId,
        title: generated.title,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename thread title", {
          threadId: input.threadId,
          cwd: input.cwd,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });
