/**
 * ThreadSessions projector — handles session-set events.
 *
 * @module ProjectionPipeline.projector.threadSessions
 */
import { type OrchestrationEvent } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import {
  ORCHESTRATION_PROJECTOR_NAMES,
  type AttachmentSideEffects,
} from "./ProjectionPipeline.helpers.ts";
import { type ProjectorDefinition, type ProjectorDeps } from "./ProjectionPipeline.projectors.ts";

export function makeThreadSessionsProjector(
  deps: Pick<ProjectorDeps, "projectionThreadRepository" | "projectionThreadSessionRepository">,
): ProjectorDefinition {
  const { projectionThreadRepository, projectionThreadSessionRepository } = deps;

  const apply = Effect.fn("applyThreadSessionsProjection")(function* (
    event: OrchestrationEvent,
    _attachmentSideEffects: AttachmentSideEffects,
  ) {
    if (event.type === "thread.deleted") {
      yield* projectionThreadSessionRepository.deleteByThreadId({
        threadId: event.payload.threadId,
      });
      return;
    }

    if (event.type === "thread.session-set") {
      yield* projectionThreadSessionRepository.upsert({
        threadId: event.payload.threadId,
        status: event.payload.session.status,
        providerName: event.payload.session.providerName,
        runtimeMode: event.payload.session.runtimeMode,
        activeTurnId: event.payload.session.activeTurnId,
        reason: event.payload.session.reason ?? null,
        lastError: event.payload.session.lastError,
        updatedAt: event.payload.session.updatedAt,
      });
      return;
    }

    if (event.type !== "thread.turn-start-failed") {
      return;
    }
    const existing = yield* projectionThreadSessionRepository.getByThreadId({
      threadId: event.payload.threadId,
    });
    if (Option.isSome(existing)) {
      yield* projectionThreadSessionRepository.upsert({
        ...existing.value,
        status: "error",
        activeTurnId: null,
        reason: event.payload.context,
        lastError: event.payload.detail,
        updatedAt: event.payload.createdAt,
      });
      return;
    }

    const thread = yield* projectionThreadRepository.getById({
      threadId: event.payload.threadId,
    });
    if (Option.isNone(thread)) {
      return;
    }
    yield* projectionThreadSessionRepository.upsert({
      threadId: event.payload.threadId,
      status: "error",
      providerName: thread.value.modelSelection.provider,
      runtimeMode: thread.value.runtimeMode,
      activeTurnId: null,
      reason: event.payload.context,
      lastError: event.payload.detail,
      updatedAt: event.payload.createdAt,
    });
  });

  return { name: ORCHESTRATION_PROJECTOR_NAMES.threadSessions, apply };
}
