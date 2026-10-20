import type { OrchestrationEvent } from "@bigbud/contracts";
import { Cause, Effect, Semaphore } from "effect";
import { hasTextGenerationUncertainty } from "@bigbud/shared/internalTextGeneration";
import { fallbackThreadTitleFromPrompt } from "@bigbud/shared/String";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { resolveDefaultChatCwd } from "../../ws/serverSettings.ts";
import { maybeGenerateThreadTitleForFirstTurn } from "./ProviderCommandReactorSessionOps.title.ts";
import { readTitleStage } from "./ProviderCommandReactorSessionOps.title.state.ts";
import { maybeGenerateAndRenameWorktreeBranchForFirstTurn } from "./ProviderCommandReactorSessionOps.firstTurn.ts";
import { resolveWorkspaceExecutionTargetId } from "../../workspace-target/workspaceTarget.ts";
import { maybeGenerateThreadElevatorSummary } from "./ProviderCommandReactorHandlers.elevatorSummary.ts";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";
import {
  recordThreadTextGenerationStatus,
  recordThreadTextGenerationStatusRequired,
} from "../../git/Layers/InternalTextGeneration.status.ts";
import {
  hasTextGenerationRequestStage,
  readTextGenerationRequest,
  recordTextGenerationRequestStage,
} from "../../git/Layers/InternalTextGeneration.requests.ts";

/** Successful turns unlock deferred jobs; explicit retries never replay a chat message. */
export const makeTextGenerationActivityHandler = (services: SessionOpServices) =>
  Effect.gen(function* () {
    const permits = yield* Semaphore.make(2);
    const executingRequests = new Set<string>();
    const handle = Effect.fn("handleTextGenerationActivity")(function* (
      event: Pick<Extract<OrchestrationEvent, { type: "thread.activity-appended" }>, "payload">,
    ) {
      const { activity, threadId } = event.payload;
      const retry = activity.kind === "text-generation.retry-requested";
      const recovery = activity.kind === "text-generation.title-recovery";
      if (
        !retry &&
        !recovery &&
        activity.kind !== "text-generation.model-succeeded" &&
        activity.kind !== "text-generation.user-turn-bound"
      )
        return;
      const requested =
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        "operation" in activity.payload
          ? activity.payload.operation
          : null;
      const thread = yield* services.resolveThread(threadId);
      if (!thread || thread.archivedAt || thread.deletingAt || thread.deletedAt) return;
      const request = retry ? readTextGenerationRequest(activity) : null;
      if (retry && !request) {
        yield* Effect.logWarning("unscoped legacy text generation request cannot be recovered", {
          threadId,
          activityId: activity.id,
        });
        yield* recordTextGenerationRequestStage(
          services.orchestrationEngine,
          threadId,
          activity,
          "settled",
        );
        return;
      }
      if (request && hasTextGenerationRequestStage(thread.activities, request.requestId, "settled"))
        return;
      const settings = yield* services.serverSettingsService.getSettings.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("internal text generation settings unavailable", {
            threadId,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
      if (!settings) return;
      const model = yield* services.orchestrationEngine.getReadModel();
      const cwd =
        resolveThreadWorkspaceCwd({ thread, projects: model.projects }) ??
        resolveDefaultChatCwd(settings);
      if (!retry && !recovery) {
        const deferredBranch = thread.activities.findLast(
          (item) =>
            [
              "text-generation.deferred",
              "text-generation.failed",
              "text-generation.completed",
            ].includes(item.kind) &&
            typeof item.payload === "object" &&
            item.payload !== null &&
            "operation" in item.payload &&
            item.payload.operation === "branch",
        );
        const snapshot = deferredBranch?.payload as
          | { branch?: string; worktreePath?: string; workspaceExecutionTargetId?: string }
          | undefined;
        const firstMessage = thread.messages.find((message) => message.role === "user");
        if (
          deferredBranch?.kind === "text-generation.deferred" &&
          snapshot &&
          firstMessage &&
          snapshot.branch === thread.branch &&
          snapshot.worktreePath === thread.worktreePath &&
          snapshot.workspaceExecutionTargetId === resolveWorkspaceExecutionTargetId(thread)
        ) {
          yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn(services)({
            threadId,
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            messageText: firstMessage.text,
            attachments: firstMessage.attachments ?? [],
          }).pipe(Effect.forkScoped);
        }
      }
      for (const operation of ["title", "summary"] as const) {
        if (recovery && operation !== "title") continue;
        if (retry && requested !== operation) continue;
        if (hasTextGenerationUncertainty(thread.activities, operation)) {
          if (
            !thread.activities.some(
              (item) =>
                item.kind === "text-generation.uncertain" &&
                (item.payload as { operation?: unknown } | null)?.operation === operation,
            )
          )
            yield* recordThreadTextGenerationStatusRequired(
              services.orchestrationEngine,
              threadId,
              operation,
              "uncertain",
            );
          if (request)
            yield* recordTextGenerationRequestStage(
              services.orchestrationEngine,
              threadId,
              activity,
              "settled",
            );
          continue;
        }
        if (request && executingRequests.has(request.requestId)) continue;
        if (request) {
          const expected = request.context;
          if (
            expected.cwd !== cwd ||
            expected.workspaceExecutionTargetId !== resolveWorkspaceExecutionTargetId(thread) ||
            expected.projectId !== thread.projectId ||
            expected.branch !== thread.branch ||
            expected.worktreePath !== thread.worktreePath ||
            expected.title !== thread.title
          ) {
            yield* recordThreadTextGenerationStatus(
              services.orchestrationEngine,
              threadId,
              operation,
              "unchanged",
            );
            yield* recordTextGenerationRequestStage(
              services.orchestrationEngine,
              threadId,
              activity,
              "settled",
            );
            continue;
          }
          if (hasTextGenerationRequestStage(thread.activities, request.requestId, "started")) {
            // A process died after claiming provider work. Its delivery is ambiguous: never charge it again automatically.
            yield* Effect.logWarning(
              "interrupted text generation request cannot be replayed automatically",
              { threadId, requestId: request.requestId },
            );
            yield* recordThreadTextGenerationStatus(
              services.orchestrationEngine,
              threadId,
              operation,
              "failed",
              {
                finalFailure:
                  operation === "title" && readTitleStage(thread, 4)?.state === "failed",
              },
            );
            yield* recordTextGenerationRequestStage(
              services.orchestrationEngine,
              threadId,
              activity,
              "settled",
            );
            continue;
          }
        }
        const first = thread.messages.find((message) => message.role === "user");
        const deferred = thread.activities.findLast(
          (item) =>
            item.kind === "text-generation.deferred" &&
            typeof item.payload === "object" &&
            item.payload !== null &&
            "titleSeed" in item.payload,
        );
        const deferredSeed =
          deferred?.payload &&
          typeof deferred.payload === "object" &&
          "titleSeed" in deferred.payload &&
          typeof deferred.payload.titleSeed === "string"
            ? deferred.payload.titleSeed
            : null;
        if (operation === "title" && !first) {
          if (retry)
            yield* recordThreadTextGenerationStatus(
              services.orchestrationEngine,
              threadId,
              "title",
              "failed",
            );
          if (request)
            yield* recordTextGenerationRequestStage(
              services.orchestrationEngine,
              threadId,
              activity,
              "settled",
            );
          continue;
        }
        if (request) executingRequests.add(request.requestId);
        const job =
          operation === "summary"
            ? maybeGenerateThreadElevatorSummary(services)({ threadId, force: retry })
            : maybeGenerateThreadTitleForFirstTurn(services)({
                threadId,
                cwd,
                messageText: first!.text,
                attachments: first!.attachments ?? [],
                modelSelection: thread.modelSelection,
                titleSeed: deferredSeed ?? fallbackThreadTitleFromPrompt(first!.text),
                retry,
              });
        const execution = request
          ? Effect.gen(function* () {
              yield* recordTextGenerationRequestStage(
                services.orchestrationEngine,
                threadId,
                activity,
                "started",
              );
              yield* job;
              yield* recordTextGenerationRequestStage(
                services.orchestrationEngine,
                threadId,
                activity,
                "settled",
              );
            })
          : job;
        const guarded = execution.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("metadata generation request failed", {
                  threadId,
                  cause: Cause.pretty(cause),
                }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (request) executingRequests.delete(request.requestId);
            }),
          ),
        );
        if (request || recovery) yield* guarded;
        else yield* guarded.pipe(Effect.forkScoped);
      }
    });
    // Retry recovery is detached from chat intent workers, and hydrates/runs at most two jobs at once.
    return (event: Parameters<typeof handle>[0]) =>
      ["text-generation.retry-requested", "text-generation.title-recovery"].includes(
        event.payload.activity.kind,
      )
        ? permits.withPermits(1)(handle(event)).pipe(Effect.forkScoped, Effect.asVoid)
        : handle(event);
  });
