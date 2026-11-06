import {
  CommandId,
  EventId,
  type ModelSelection,
  type OrchestrationThread,
} from "@bigbud/contracts";
import { Effect, Schema } from "effect";
import { hasTextGenerationUncertainty } from "@bigbud/shared/internalTextGeneration";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";
import { ModelSelection as ModelSelectionSchema } from "@bigbud/contracts/orchestration/orchestration.provider";

export interface TitleStageFailure {
  readonly kind: string;
  readonly detail: string;
}

const Stage = Schema.Struct({
  stage: Schema.Literals([1, 2, 3, 4]),
  state: Schema.Literals(["started", "failed", "completed", "cancelled", "unchanged", "uncertain"]),
  uncertaintyProtected: Schema.optional(Schema.Boolean),
  model: Schema.optional(ModelSelectionSchema),
});
export type TitleStage = 1 | 2 | 3 | 4;
/** Each stage has one durable claim. A settlement is evidence, not an array-order tie breaker. */
export function readTitleStage(thread: OrchestrationThread, stage: TitleStage) {
  const records = thread.activities.flatMap((item) =>
    item.kind === "text-generation.title-stage" &&
    Schema.is(Stage)(item.payload) &&
    item.payload.stage === stage
      ? [item.payload]
      : [],
  );
  // Real provider uncertainty is never repaired by a coincidental terminal record.
  const protectedUncertainty = records.find(
    (record) =>
      record.state === "uncertain" &&
      (record.uncertaintyProtected ||
        thread.activities.some(
          (item) =>
            item.kind === "text-generation.title-stage" &&
            item.payload === record &&
            (item.id !== `text-generation-title-stage:${thread.id}:${stage}:uncertain` ||
              item.createdAt !== thread.createdAt),
        )),
  );
  if (protectedUncertainty) return protectedUncertainty;
  for (const state of [
    "completed",
    "cancelled",
    "unchanged",
    "failed",
    "uncertain",
    "started",
  ] as const) {
    const record = records.find((item) => item.state === state);
    if (record) return record;
  }
  return null;
}
/** Ignore only legacy inferred uncertainty with a definitive settlement for the same claim.
 * Native uncertainty IDs, protected dispatches, explicit retries, and missing evidence still block.
 * This is a read-time interpretation; history is never deleted or blindly replayed.
 */
export function hasUnresolvedTitleGeneration(thread: OrchestrationThread): boolean {
  if (
    ([1, 2, 3, 4] as const).some((stage) => {
      const state = readTitleStage(thread, stage)?.state;
      return state === "started" || state === "uncertain";
    })
  )
    return true;
  if (!hasTextGenerationUncertainty(thread.activities, "title")) return false;
  const statuses = thread.activities.filter(
    (item) =>
      [
        "text-generation.started",
        "text-generation.failed",
        "text-generation.completed",
        "text-generation.uncertain",
      ].includes(item.kind) &&
      (item.payload as { operation?: unknown } | null)?.operation === "title",
  );
  const latest = statuses.at(-1);
  const payload = latest?.payload as {
    uncertaintyId?: unknown;
    uncertaintyProtected?: unknown;
  } | null;
  if (
    latest?.kind !== "text-generation.uncertain" ||
    payload?.uncertaintyId ||
    payload?.uncertaintyProtected
  )
    return true;
  // An actual native dispatch without a later settlement must never authorize another charge.
  const lastWitness = statuses.findLast((item) => item.kind !== "text-generation.uncertain");
  if (
    lastWitness?.kind === "text-generation.started" &&
    (lastWitness.payload as { uncertaintyProtected?: unknown } | null)?.uncertaintyProtected
  )
    return true;
  if (thread.activities.some((item) => item.kind === "text-generation.retry-requested"))
    return true;
  const inferred = thread.activities.filter(
    (item) =>
      item.kind === "text-generation.title-stage" &&
      Schema.is(Stage)(item.payload) &&
      item.payload.state === "uncertain",
  );
  return (
    inferred.length === 0 ||
    inferred.some((item) => {
      if (!Schema.is(Stage)(item.payload) || item.payload.uncertaintyProtected) return true;
      const stage = item.payload.stage;
      const state = readTitleStage(thread, stage)?.state;
      return (
        item.id !== `text-generation-title-stage:${thread.id}:${stage}:uncertain` ||
        item.createdAt !== thread.createdAt ||
        !["completed", "failed", "cancelled", "unchanged"].includes(state ?? "") ||
        !thread.activities.some(
          (witness) =>
            witness.id === `text-generation-title-stage:${thread.id}:${stage}:${state}` &&
            witness.createdAt === thread.createdAt &&
            witness.kind === "text-generation.title-stage" &&
            Schema.is(Stage)(witness.payload) &&
            witness.payload.stage === stage &&
            witness.payload.state === state,
        )
      );
    })
  );
}

export function titlePipelineFinished(thread: OrchestrationThread): boolean {
  return ([1, 2, 3, 4] as const).some((stage) => {
    const state = readTitleStage(thread, stage)?.state;
    return (
      state === "completed" ||
      state === "cancelled" ||
      state === "unchanged" ||
      state === "uncertain"
    );
  });
}

/** Existing command receipts claim a stage once; interrupted external work is consumed, never replayed. */
export function recordTitleStage(
  services: SessionOpServices,
  thread: OrchestrationThread,
  stage: TitleStage,
  state: (typeof Stage.Type)["state"],
  model?: ModelSelection,
  uncertaintyProtected?: boolean,
  failure?: TitleStageFailure,
) {
  const id = `text-generation-title-stage:${thread.id}:${stage}:${state}`;
  const createdAt = thread.createdAt;
  return services.orchestrationEngine
    .dispatch({
      type: "thread.activity.append",
      threadId: thread.id,
      commandId: CommandId.makeUnsafe(`server:${id}`),
      createdAt,
      activity: {
        id: EventId.makeUnsafe(id),
        kind: "text-generation.title-stage",
        tone: "info",
        summary: `Thread title stage ${stage} ${state}`,
        payload: {
          stage,
          state,
          ...(model ? { model } : {}),
          ...(uncertaintyProtected ? { uncertaintyProtected: true } : {}),
          ...(failure ? { failure } : {}),
          ...(state === "started" ? { owner: crypto.randomUUID() } : {}),
        },
        turnId: null,
        createdAt,
      },
    })
    .pipe(Effect.asVoid);
}
