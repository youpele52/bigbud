import { CommandId, EventId, TextGenerationError } from "@bigbud/contracts";
import type { RetryThreadTextGenerationInput } from "@bigbud/contracts/server/rpc.textGeneration.ts";
import { Effect } from "effect";
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
  hasTextGenerationRequestStage,
  readTextGenerationRequest,
  TEXT_GENERATION_REQUEST_KIND,
} from "../git/Layers/InternalTextGeneration.requests.ts";

/** A notice version authorizes one durable metadata request, not a replay of a chat turn. */
export function requestTextGenerationRetry(
  engine: OrchestrationEngineShape,
  input: RetryThreadTextGenerationInput,
  settings?: ServerSettingsShape,
) {
  return Effect.gen(function* () {
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
      requests.some(
        (item) => readTextGenerationRequest(item)?.sourceActivityId === input.sourceActivityId,
      )
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
      !source ||
      source.id !== input.sourceActivityId ||
      source.kind === "text-generation.completed"
    )
      return;
    if (
      source.kind !== "text-generation.failed" &&
      (isThreadTextGenerationJobActive(engine, input.threadId, input.operation) ||
        requests.some(
          (item) =>
            readTextGenerationRequest(item)?.operation === input.operation &&
            !hasTextGenerationRequestStage(thread.activities, item.id, "settled"),
        ))
    )
      return;
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
    const requestId = EventId.makeUnsafe(`text-generation-retry:${source.id}`);
    yield* engine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(`server:${requestId}`),
        threadId: input.threadId,
        createdAt: source.createdAt,
        activity: {
          id: requestId,
          kind: TEXT_GENERATION_REQUEST_KIND,
          tone: "info",
          summary: `Retrying thread ${input.operation} generation`,
          turnId: null,
          createdAt: source.createdAt,
          payload: {
            operation: input.operation,
            requestId,
            sourceActivityId: source.id,
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
