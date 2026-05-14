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
  type OrchestrationMessage,
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
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { resolveDefaultChatCwd, ServerSettingsService } from "../../ws/serverSettings.ts";
import { WorkspacePaths } from "../../workspace/Services/WorkspacePaths.ts";
import {
  canReplaceThreadTitle,
  DEFAULT_RUNTIME_MODE,
  HANDLED_TURN_START_KEY_MAX,
  HANDLED_TURN_START_KEY_TTL_MINUTES,
  isUnknownPendingApprovalRequestError,
  isUnknownPendingUserInputRequestError,
  resolveThreadTitleSeed,
  serverCommandId,
  stalePendingRequestDetail,
} from "./ProviderCommandReactorHelpers.ts";
import { makeProcessDeletionRequested } from "./ProviderCommandReactorHandlers.delete.ts";
import { makeProcessProjectDeletionRequested } from "./ProviderCommandReactorHandlers.project-delete.ts";
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

/**
 * Appends an `<attached_files>` XML block to the provider input text so the agent
 * immediately knows which files are attached. The block intentionally omits
 * source paths: adapters handle file bytes/text extraction, and exposing paths
 * can prompt agents without document APIs to read opaque binary files directly.
 *
 * Example output:
 *   <attached_files>
 *   - report.pdf (application/pdf, 120000 bytes)
 *   </attached_files>
 */
function appendFileAttachmentsToProviderInput(
  text: string,
  attachments: NonNullable<OrchestrationMessage["attachments"]>,
): string {
  const fileAttachments = attachments.filter((a) => a.type === "file");
  if (fileAttachments.length === 0) return text;
  const lines = fileAttachments.map((f) => `- ${f.name} (${f.mimeType}, ${f.sizeBytes} bytes)`);
  const block = `<attached_files>\n${lines.join("\n")}\n</attached_files>`;
  return text.length > 0 ? `${text}\n\n${block}` : block;
}

type ProviderIntentEvent = Extract<
  import("@bigbud/contracts").OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
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
  const workspacePaths = yield* WorkspacePaths;
  const fileSystem = yield* FileSystem.FileSystem;
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
    threadModelSelections,
    setThreadSession,
    resolveThread,
  };
  const processDeletionRequested = yield* makeProcessDeletionRequested;
  const processProjectDeletionRequested = yield* makeProcessProjectDeletionRequested;

  const expandTurnMessageText = expandProviderInputMentions({
    discoveryRegistry,
    fileSystem,
    workspacePaths,
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
    const providerInputText =
      thread.modelSelection.provider === "pi"
        ? providerMessageText
        : appendFileAttachmentsToProviderInput(providerMessageText, message.attachments ?? []);

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

      if (canReplaceThreadTitle(thread.title, resolvedTitleSeed)) {
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
          detail: Cause.pretty(cause),
          turnId: null,
          createdAt: event.payload.createdAt,
        }),
      ),
    );
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    yield* providerService.interruptTurn({ threadId: event.payload.threadId });
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.approval.respond.failed",
              summary: "Provider approval response failed",
              detail: isUnknownPendingApprovalRequestError(cause)
                ? stalePendingRequestDetail("approval", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            });

            if (!isUnknownPendingApprovalRequestError(cause)) return;
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
        })
        .pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
    },
  );

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    if (thread.session && thread.session.status !== "stopped") {
      yield* providerService.stopSession({ threadId: thread.id });
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

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
