import { Cause, Effect, Exit, Option, Schema } from "effect";
import {
  TextGenerationError,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationThread,
  type ThreadId,
} from "@bigbud/contracts";
import {
  successfulUserTurns,
  hasTextGenerationUncertainty,
} from "@bigbud/shared/internalTextGeneration";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";
import {
  getThreadTitleVersion,
  shouldAllowAutoTitleReplace,
} from "../../orchestration-tools/ThreadTitleLock.ts";
import { renameThreadViaOrchestration } from "../../orchestration-tools/ThreadOrchestrationTools.rename.ts";
import { threadTitleOwner } from "../../orchestration-tools/TerminalThreadTitle.ts";
import { lastSuccessfulThreadModel } from "../../git/Layers/InternalTextGeneration.success.ts";
import { sameTextGenerationWorkspace } from "../../git/Layers/InternalTextGeneration.requests.ts";
import {
  recordThreadTextGenerationStatus,
  recordThreadTextGenerationStatusRequired,
  withThreadTextGenerationJob,
} from "../../git/Layers/InternalTextGeneration.status.ts";
import { makeTextGenerationDispatchClaim } from "../../git/Layers/InternalTextGeneration.dispatch.ts";
import {
  serverCommandId,
  shouldRetryGeneratedThreadTitle,
} from "./ProviderCommandReactorHelpers.ts";
import { buildElevatorSummaryTranscript } from "./ProviderCommandReactorHandlers.elevatorSummary.ts";
import {
  readTitleStage,
  recordTitleStage,
  titlePipelineFinished,
  type TitleStage,
} from "./ProviderCommandReactorSessionOps.title.state.ts";

interface Input {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly messageText: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly modelSelection: ModelSelection;
  readonly titleSeed?: string;
  readonly retry?: boolean;
}

/** Two normal jobs (each at most two authorized candidates), one exact-model job, one exact-model tool fallback. */
export const maybeGenerateThreadTitleForFirstTurn = (services: SessionOpServices) => {
  const generate = Effect.fn("generateStagedThreadTitle")(function* (input: Input) {
    const { orchestrationEngine: engine, resolveThread } = services;
    const initial = yield* resolveThread(input.threadId);
    if (!initial || initial.archivedAt || initial.deletingAt || initial.deletedAt) return;
    const unresolved = ([1, 2, 3, 4] as const).find((stage) => {
      const state = readTitleStage(initial, stage);
      return state?.state === "uncertain" || state?.state === "started";
    });
    if (unresolved || hasTextGenerationUncertainty(initial.activities, "title")) {
      if (unresolved && readTitleStage(initial, unresolved)?.state === "started") {
        yield* recordTitleStage(services, initial, unresolved, "uncertain");
      }
      if (
        !initial.activities.some(
          (item) =>
            item.kind === "text-generation.uncertain" &&
            (item.payload as { operation?: unknown } | null)?.operation === "title",
        )
      )
        yield* recordThreadTextGenerationStatusRequired(
          engine,
          input.threadId,
          "title",
          "uncertain",
        );
      return;
    }
    if (!input.retry && titlePipelineFinished(initial)) return;
    const titleVersion = getThreadTitleVersion(input.threadId);
    const allowed = (thread: OrchestrationThread | undefined): boolean =>
      !!thread &&
      !thread.archivedAt &&
      !thread.deletingAt &&
      !thread.deletedAt &&
      sameTextGenerationWorkspace(initial, thread) &&
      initial.title === thread.title &&
      getThreadTitleVersion(input.threadId) === titleVersion &&
      shouldAllowAutoTitleReplace({
        threadId: input.threadId,
        currentTitle: thread.title,
        titleOwner: threadTitleOwner(thread),
        ...(input.titleSeed !== undefined ? { titleSeed: input.titleSeed } : {}),
      });
    if (!allowed(initial)) {
      const pending = ([4, 3, 2, 1] as const).find((stage) => readTitleStage(initial, stage));
      if (pending && !input.retry) {
        yield* recordTitleStage(services, initial, pending, "unchanged");
        yield* recordThreadTextGenerationStatus(engine, input.threadId, "title", "unchanged");
      } else if (
        !input.retry &&
        initial.activities.some(
          (activity) =>
            activity.kind === "text-generation.deferred" &&
            typeof activity.payload === "object" &&
            activity.payload !== null &&
            "operation" in activity.payload &&
            activity.payload.operation === "title",
        )
      ) {
        yield* recordThreadTextGenerationStatus(engine, input.threadId, "title", "unchanged");
      }
      return;
    }
    if (!input.retry && readTitleStage(initial, 4)?.state === "failed") {
      if (
        !initial.activities.some(
          (activity) =>
            activity.kind === "text-generation.failed" &&
            typeof activity.payload === "object" &&
            activity.payload !== null &&
            "finalFailure" in activity.payload &&
            activity.payload.finalFailure === true,
        )
      ) {
        yield* recordThreadTextGenerationStatus(engine, input.threadId, "title", "failed", {
          finalFailure: true,
        });
      }
      return;
    }
    const settings = yield* services.serverSettingsService.getSettings;
    if (!settings.textGenerationModelSelection && !lastSuccessfulThreadModel(initial)) {
      yield* recordThreadTextGenerationStatus(engine, input.threadId, "title", "deferred", {
        titleSeed: input.titleSeed ?? initial.title,
      });
      return;
    }

    const attempt = (
      stage: TitleStage,
      thread: OrchestrationThread,
      claim: ReturnType<typeof makeTextGenerationDispatchClaim>,
      exactModel?: ModelSelection,
    ) =>
      Effect.gen(function* () {
        const successful = exactModel ?? lastSuccessfulThreadModel(thread);
        const context = stage === 4 ? buildElevatorSummaryTranscript(thread.messages) : null;
        if (stage === 4 && !context)
          return yield* new TextGenerationError({
            operation: "generateThreadTitle",
            kind: "provider",
            detail: "No readable conversation context is available for the rename tool fallback.",
          });
        const generated = yield* services.textGeneration.generateThreadTitle({
          cwd: input.cwd,
          message:
            stage === 4
              ? `Rename this thread from its conversation context. Return only a concise title.\n\n${context}`
              : input.messageText,
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          modelSelection: exactModel ?? input.modelSelection,
          successfulModelSelection: successful,
          beforeV2Dispatch: claim.beforeV2Dispatch,
          titleSeed: input.titleSeed,
          ...(exactModel ? { verifiedThreadModelOnly: true } : {}),
        });
        if (
          shouldRetryGeneratedThreadTitle({
            generatedTitle: generated.title,
            ...(input.titleSeed !== undefined ? { titleSeed: input.titleSeed } : {}),
          })
        )
          return yield* new TextGenerationError({
            operation: "generateThreadTitle",
            kind: "provider",
            detail: "Generated thread title was empty or too weak.",
          });
        const fresh = yield* resolveThread(input.threadId);
        if (!fresh || !allowed(fresh)) return "unchanged" as const;
        if (stage === 4) {
          const message = fresh.messages.find((item) => item.role === "user");
          if (!message || !services.threadDelegationRepository)
            return yield* new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "Scoped rename tool is unavailable.",
            });
          // Execute the real scoped tool handler, without injecting a chat turn or fabricating tool events.
          yield* renameThreadViaOrchestration({
            orchestrationEngine: engine,
            threadDelegationRepository: services.threadDelegationRepository,
            threadId: input.threadId,
            title: generated.title,
            sourceMessageId: message.id,
            invocationId: input.retry
              ? `metadata-retry:${crypto.randomUUID()}`
              : "automatic-title-context-fallback",
          });
        } else {
          yield* engine.dispatch({
            type: "thread.meta.update",
            commandId: serverCommandId("thread-title-rename"),
            threadId: input.threadId,
            title: generated.title,
          });
        }
        return "completed" as const;
      });

    const execute = (stage: TitleStage, thread: OrchestrationThread, model?: ModelSelection) =>
      Effect.gen(function* () {
        const claim = makeTextGenerationDispatchClaim(engine, input.threadId, "title");
        const result = yield* Effect.exit(
          attempt(stage, thread, claim, model).pipe(
            Effect.onInterrupt(() =>
              input.retry
                ? Effect.void
                : recordTitleStage(
                    services,
                    thread,
                    stage,
                    claim.isClaimed() ? "uncertain" : "cancelled",
                    model,
                  ),
            ),
          ),
        );
        if (Exit.isSuccess(result)) return result.value;
        if (Cause.hasInterruptsOnly(result.cause)) return yield* Effect.interrupt;
        const error = Cause.findErrorOption(result.cause);
        if (
          Option.isSome(error) &&
          Schema.is(TextGenerationError)(error.value) &&
          error.value.kind === "uncertain"
        ) {
          yield* recordThreadTextGenerationStatusRequired(
            engine,
            input.threadId,
            "title",
            "uncertain",
            error.value.uncertaintyId ? { uncertaintyId: error.value.uncertaintyId } : {},
          );
          return "uncertain" as const;
        }
        if (
          Option.isSome(error) &&
          Schema.is(TextGenerationError)(error.value) &&
          (error.value.kind === "cancelled" || error.value.kind === "invalid-input")
        )
          return "cancelled" as const;
        yield* Effect.logWarning("staged thread title attempt failed", {
          threadId: input.threadId,
          stage,
          cause: Cause.pretty(result.cause),
        });
        if (claim.isClaimed())
          yield* recordThreadTextGenerationStatusRequired(
            engine,
            input.threadId,
            "title",
            "failed",
          );
        return "failed" as const;
      });

    if (input.retry) {
      const model = lastSuccessfulThreadModel(initial);
      const finalRecovery = readTitleStage(initial, 4) !== null;
      if (finalRecovery && !model) return;
      yield* recordThreadTextGenerationStatusRequired(engine, input.threadId, "title", "started");
      const outcome = yield* execute(
        finalRecovery ? 4 : 1,
        initial,
        finalRecovery ? (model ?? undefined) : undefined,
      );
      if (outcome === "uncertain") return;
      yield* recordThreadTextGenerationStatus(
        engine,
        input.threadId,
        "title",
        outcome === "failed" ? "failed" : outcome === "completed" ? "completed" : "unchanged",
        { finalFailure: finalRecovery && outcome === "failed" },
      );
      return;
    }
    for (const stage of [1, 2, 3, 4] as const) {
      const thread = yield* resolveThread(input.threadId);
      if (!thread || !allowed(thread)) return;
      const existing = readTitleStage(thread, stage);
      if (existing?.state === "started") {
        // No settlement witness exists for this durable claim. A different stage is still paid replay.
        yield* recordTitleStage(services, thread, stage, "uncertain", existing.model);
        yield* recordThreadTextGenerationStatusRequired(
          engine,
          input.threadId,
          "title",
          "uncertain",
        );
        return;
      }
      if (existing?.state === "failed") continue;
      if (existing) return;
      const turns = successfulUserTurns(thread.activities);
      const thirdModel = readTitleStage(thread, 3)?.model ?? turns[2]?.model;
      if (stage >= 3 && (!thirdModel || turns.length < 3)) return;
      const model = stage >= 3 ? thirdModel : undefined;
      yield* recordTitleStage(services, thread, stage, "started", model);
      const outcome = yield* execute(stage, thread, model);
      yield* recordTitleStage(services, thread, stage, outcome, model);
      if (outcome === "uncertain") return;
      if (outcome !== "failed") {
        yield* recordThreadTextGenerationStatus(
          engine,
          input.threadId,
          "title",
          outcome === "completed" ? "completed" : "unchanged",
        );
        return;
      }
      if (stage === 4)
        yield* recordThreadTextGenerationStatus(engine, input.threadId, "title", "failed", {
          finalFailure: true,
        });
    }
  });
  return (input: Input) =>
    withThreadTextGenerationJob(
      services.orchestrationEngine,
      input.threadId,
      "title",
      generate(input),
      true,
    );
};
