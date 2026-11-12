import { CommandId, EventId, TextGenerationError } from "@bigbud/contracts";
import type { RetryThreadTextGenerationInput } from "@bigbud/contracts/server/rpc.textGeneration.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { hasTextGenerationUncertainty } from "@bigbud/shared/internalTextGeneration";
import {
  ensureOrchestrationThreadState,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { resolveWorkspaceExecutionTargetId } from "../workspace-target/workspaceTarget.ts";
import { resolveDefaultChatCwd, type ServerSettingsShape } from "./serverSettings.ts";
import { isThreadTextGenerationJobActive } from "../git/Layers/InternalTextGeneration.status.ts";
import {
  captureLegacyMetadataClaims,
  MAX_RECOVERY_CLAIMS,
} from "../persistence/Layers/ThreadMetadataGeneration.legacy.authorization.ts";
import {
  hasTextGenerationRequestStage,
  readTextGenerationRequest,
  TEXT_GENERATION_REQUEST_KIND,
} from "../git/Layers/InternalTextGeneration.requests.ts";

/** A stable notice or explicitly confirmed identity authorizes one request, never a chat replay. */
export function requestTextGenerationRetry(
  engine: OrchestrationEngineShape,
  input: RetryThreadTextGenerationInput,
  settings?: ServerSettingsShape,
) {
  return Effect.gen(function* () {
    const newRequest = input.newRequestId !== undefined;
    if (
      (newRequest &&
        (input.acknowledgeHistoricalUncertainty !==
          "authorize-new-budget-with-unresolved-history" ||
          input.sourceActivityId !== undefined)) ||
      (!newRequest &&
        (input.sourceActivityId === undefined ||
          input.acknowledgeHistoricalUncertainty !== undefined))
    )
      return yield* new TextGenerationError({
        operation: "retryTextGeneration",
        detail:
          "A new generation requires explicit cost acknowledgement and a stable request identity.",
      });
    const sourceIdentity = input.newRequestId ?? input.sourceActivityId!;
    const requestId = EventId.makeUnsafe(
      `${input.acknowledgeHistoricalUncertainty ? "text-generation-recovery" : "text-generation-retry"}:${sourceIdentity}`,
    );
    const thread = yield* ensureOrchestrationThreadState(engine, input.threadId, "history");
    if (!thread || thread.deletedAt || thread.deletingAt || thread.archivedAt) {
      return yield* new TextGenerationError({
        operation: "retryTextGeneration",
        detail: "Thread is unavailable for text generation.",
      });
    }
    if (hasTextGenerationUncertainty(thread.activities, input.operation))
      return yield* new TextGenerationError({
        operation: "retryTextGeneration",
        kind: "uncertain",
        detail:
          "Original native generation is unconfirmed. Verify its settlement before starting another request.",
      });
    const requests = thread.activities.filter((item) => readTextGenerationRequest(item));
    if (
      requests.some((item) => {
        const request = readTextGenerationRequest(item);
        return (
          request !== null &&
          request.requestId === requestId &&
          request.operation === input.operation
        );
      })
    )
      return;
    const source = thread.activities.findLast(
      (item) =>
        ["text-generation.failed", "text-generation.started", "text-generation.completed"].includes(
          item.kind,
        ) &&
        typeof item.payload === "object" &&
        item.payload !== null &&
        "operation" in item.payload &&
        item.payload.operation === input.operation,
    );
    if (
      !newRequest &&
      (!source ||
        source.id !== input.sourceActivityId ||
        source.kind === "text-generation.completed")
    )
      return;
    if (
      (newRequest || source?.kind !== "text-generation.failed") &&
      (isThreadTextGenerationJobActive(engine, input.threadId, input.operation) ||
        requests.some(
          (item) =>
            readTextGenerationRequest(item)?.operation === input.operation &&
            !hasTextGenerationRequestStage(thread.activities, item.id, "settled"),
        ))
    ) {
      if (newRequest)
        return yield* new TextGenerationError({
          operation: "retryTextGeneration",
          detail: "Another generation request is still active for this thread.",
        });
      return;
    }
    if (
      newRequest &&
      input.operation === "title" &&
      !thread.messages.some((m) => m.role === "user")
    )
      return yield* new TextGenerationError({
        operation: "retryTextGeneration",
        detail: "Send a message before requesting a generated title.",
      });
    const model = yield* engine.getReadModel();
    const configured = settings
      ? yield* settings.getSettings.pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: "retryTextGeneration",
                detail: "Could not load generation workspace settings.",
                cause,
              }),
          ),
        )
      : null;
    const cwd =
      resolveThreadWorkspaceCwd({ thread, projects: model.projects }) ??
      (configured ? resolveDefaultChatCwd(configured) : null);
    if (!cwd)
      return yield* new TextGenerationError({
        operation: "retryTextGeneration",
        detail: "The generation workspace is unavailable.",
      });
    const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (input.acknowledgeHistoricalUncertainty && Option.isNone(sql))
      return yield* new TextGenerationError({
        operation: "retryTextGeneration",
        detail: "Historical reservation authority is unavailable.",
      });
    const legacyRecovery = input.acknowledgeHistoricalUncertainty
      ? {
          acknowledgement: input.acknowledgeHistoricalUncertainty,
          claims: yield* captureLegacyMetadataClaims(input.threadId).pipe(
            Effect.provideService(SqlClient.SqlClient, Option.getOrThrow(sql)),
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation: "retryTextGeneration",
                  detail: "Could not capture historical generation reservations.",
                  cause,
                }),
            ),
          ),
        }
      : undefined;
    if (legacyRecovery && legacyRecovery.claims.length > MAX_RECOVERY_CLAIMS)
      return yield* new TextGenerationError({
        operation: "retryTextGeneration",
        detail: "Too many unresolved historical reservations for scoped recovery.",
      });
    const createdAt = newRequest ? new Date().toISOString() : source!.createdAt;
    yield* engine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(`server:${requestId}`),
        threadId: input.threadId,
        createdAt,
        activity: {
          id: requestId,
          kind: TEXT_GENERATION_REQUEST_KIND,
          tone: "info",
          summary: `Retrying thread ${input.operation} generation`,
          turnId: null,
          createdAt,
          payload: {
            operation: input.operation,
            requestId,
            sourceActivityId: sourceIdentity,
            ...(legacyRecovery ? { legacyRecovery } : {}),
            context: {
              cwd,
              workspaceExecutionTargetId: resolveWorkspaceExecutionTargetId(thread),
              projectId: thread.projectId,
              branch: thread.branch,
              worktreePath: thread.worktreePath,
              title: thread.title,
            },
          },
        },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "retryTextGeneration",
              detail: "Could not queue text generation retry.",
              cause,
            }),
        ),
      );
  });
}
