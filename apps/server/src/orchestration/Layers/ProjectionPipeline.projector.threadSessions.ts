/**
 * ThreadSessions projector — handles session-set events.
 *
 * @module ProjectionPipeline.projector.threadSessions
 */
import { type OrchestrationEvent } from "@bigbud/contracts";
import { Effect } from "effect";

import {
  ORCHESTRATION_PROJECTOR_NAMES,
  type AttachmentSideEffects,
} from "./ProjectionPipeline.helpers.ts";
import { type ProjectorDefinition, type ProjectorDeps } from "./ProjectionPipeline.projectors.ts";

export function makeThreadSessionsProjector(
  deps: Pick<ProjectorDeps, "projectionThreadSessionRepository">,
): ProjectorDefinition {
  const { projectionThreadSessionRepository } = deps;

  const apply = Effect.fn("applyThreadSessionsProjection")(function* (
    event: OrchestrationEvent,
    _attachmentSideEffects: AttachmentSideEffects,
  ) {
    if (event.type !== "thread.session-set") {
      return;
    }
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
  });

  return { name: ORCHESTRATION_PROJECTOR_NAMES.threadSessions, apply };
}
