import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts";
import { Effect } from "effect";

import { BIGBUD_CAPABILITY_CATALOG } from "../../capabilities/BigbudCapabilityTracks.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { buildResumedTurnInput, toNonEmptyProviderInput } from "./ProviderCommandReactorHelpers.ts";
import {
  appendReferencedThreadsToProviderInput,
  prependThreadContextToProviderInput,
  resolveAndExportThreadContextPath,
} from "./ProviderCommandReactorSessionOps.threadContext.ts";
import { shouldRebuildProviderContextFromTranscript } from "./ProviderCommandReactorSessionOps.context.ts";
import { prependCapabilityContextToProviderInput } from "./ProviderCommandReactorSessionOps.capabilityContext.ts";
import { rolloverProviderSessionAtHighWater } from "./ProviderCommandReactorSessionOps.recovery.ts";
import type { ensureSessionForThread } from "./ProviderCommandReactorSessionOps.ts";
import {
  ongoingProviderWorkError,
  capturedModelSelectionError,
  type ResolvedTurnExecutionSettings,
} from "./ProviderCommandReactorSessionOps.settings.ts";
import type {
  SendTurnForThreadInput,
  SessionOpServices,
} from "./ProviderCommandReactorSessionOps.types.ts";

export const sendTurnAttempt = (
  services: SessionOpServices,
  ensureSession: ReturnType<typeof ensureSessionForThread>,
) =>
  Effect.fn("sendTurnAttempt")(function* (
    input: SendTurnForThreadInput & ResolvedTurnExecutionSettings,
  ) {
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
    const ongoingWorkError = ongoingProviderWorkError(thread, activeSession);
    if (ongoingWorkError) return yield* ongoingWorkError;

    activeSession = yield* rolloverProviderSessionAtHighWater({
      providerService,
      states: services.capabilityContextStates,
      threadId: input.threadId,
      sessionEpoch: thread.session?.sessionEpoch ?? 0,
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

    yield* ensureSession(input.threadId, input.createdAt, {
      ...(input.modelSelectionWasCaptured ? { modelSelection: input.modelSelection } : {}),
      runtimeMode: input.runtimeMode,
      requireExactModel: input.modelSelectionWasCaptured,
      restartFreshIfInactive: shouldBootstrapFromTranscript,
    });
    activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : (yield* providerService.getCapabilities(activeSession.provider)).sessionModelSwitch;
    const capturedModelError = capturedModelSelectionError({
      modelSelection: input.modelSelection,
      activeSession,
      sessionModelSwitch,
      requireExactModel: input.modelSelectionWasCaptured,
    });
    if (capturedModelError) return yield* capturedModelError;
    // Only legacy omission may retain an unsupported adapter's live model.
    const modelForTurn =
      !input.modelSelectionWasCaptured &&
      sessionModelSwitch === "unsupported" &&
      activeSession?.model !== undefined
        ? { ...input.modelSelection, model: activeSession.model }
        : input.modelSelection;
    threadModelSelections.set(input.threadId, modelForTurn);

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
          provider: modelForTurn.provider,
          model: modelForTurn.model,
          runtimeMode: input.runtimeMode,
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

    const providerAttachments = normalizedAttachments.filter(
      (attachment) => attachment.type !== "thread",
    );
    const sessionBeforeTurn = (yield* resolveThread(input.threadId))?.session ?? null;
    const turn = yield* providerService.sendTurn({
      threadId: input.threadId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(providerAttachments.length > 0 ? { attachments: providerAttachments } : {}),
      modelSelection: modelForTurn,
      interactionMode: input.interactionMode,
      sessionEpoch: sessionBeforeTurn?.sessionEpoch ?? 0,
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
            input.modelSelection.provider,
          runtimeMode:
            sessionAfterTurn?.runtimeMode ?? sessionBeforeTurn?.runtimeMode ?? input.runtimeMode,
          activeTurnId: turn.turnId,
          sessionEpoch: sessionBeforeTurn?.sessionEpoch ?? 0,
          reason: null,
          lastError: null,
          updatedAt: input.createdAt,
        },
        createdAt: input.createdAt,
        expectedSessionEpoch: sessionBeforeTurn?.sessionEpoch ?? 0,
      });
    }
  });
