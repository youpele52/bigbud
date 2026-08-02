import { UserInputQuestion } from "@bigbud/contracts/orchestration/providerRuntime.payloads.ts";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import { Effect, Option, Schema } from "effect";

import type { AttachmentSideEffects } from "./ProjectionPipeline.helpers.ts";
import {
  extractActivityRequestId,
  ORCHESTRATION_PROJECTOR_NAMES,
} from "./ProjectionPipeline.helpers.ts";
import type { ProjectorDefinition, ProjectorDeps } from "./ProjectionPipeline.projectors.ts";

const UserInputQuestions = Schema.Array(UserInputQuestion);

function extractQuestions(payload: unknown): ReadonlyArray<UserInputQuestion> | null {
  if (typeof payload !== "object" || payload === null || !("questions" in payload)) return null;
  const questions = (payload as { readonly questions?: unknown }).questions;
  return Schema.is(UserInputQuestions)(questions) ? questions : null;
}

export function makePendingUserInputsProjector(
  deps: Pick<ProjectorDeps, "projectionPendingUserInputRepository">,
): ProjectorDefinition {
  const { projectionPendingUserInputRepository } = deps;

  const apply = Effect.fn("applyPendingUserInputsProjection")(function* (
    event: OrchestrationEvent,
    _attachmentSideEffects: AttachmentSideEffects,
  ) {
    switch (event.type) {
      case "thread.deleted":
        yield* projectionPendingUserInputRepository.deleteByThreadId({
          threadId: event.payload.threadId,
        });
        return;

      case "project.deleted":
        yield* projectionPendingUserInputRepository.deleteByProjectId({
          projectId: event.payload.projectId,
        });
        return;

      case "thread.activity-appended": {
        const activity = event.payload.activity;
        if (
          activity.kind !== "user-input.requested" &&
          activity.kind !== "user-input.resolved" &&
          activity.kind !== "provider.user-input.respond.failed"
        ) {
          return;
        }
        const requestId = extractActivityRequestId(activity.payload) ?? event.metadata.requestId;
        if (requestId === undefined || requestId === null) return;
        const existing = yield* projectionPendingUserInputRepository.getByRequestId({ requestId });

        if (
          activity.kind === "user-input.resolved" ||
          activity.kind === "provider.user-input.respond.failed"
        ) {
          if (Option.isNone(existing) || existing.value.status === "resolved") return;
          yield* projectionPendingUserInputRepository.upsert({
            ...existing.value,
            status: "resolved",
            resolvedAt: activity.createdAt,
          });
          return;
        }

        if (Option.isSome(existing) && existing.value.status === "resolved") return;
        const questions = extractQuestions(activity.payload);
        if (questions === null) return;
        yield* projectionPendingUserInputRepository.upsert({
          requestId,
          threadId: event.payload.threadId,
          turnId: activity.turnId,
          status: "pending",
          questions,
          createdAt: Option.isSome(existing) ? existing.value.createdAt : activity.createdAt,
          resolvedAt: null,
        });
        return;
      }

      default:
        return;
    }
  });

  return { name: ORCHESTRATION_PROJECTOR_NAMES.pendingUserInputs, apply };
}
