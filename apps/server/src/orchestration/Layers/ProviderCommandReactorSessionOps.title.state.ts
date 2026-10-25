import {
  CommandId,
  EventId,
  type ModelSelection,
  type OrchestrationThread,
} from "@bigbud/contracts";
import { Effect, Schema } from "effect";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";
import { ModelSelection as ModelSelectionSchema } from "@bigbud/contracts/orchestration/orchestration.provider";

const Stage = Schema.Struct({
  stage: Schema.Literals([1, 2, 3, 4]),
  state: Schema.Literals(["started", "failed", "completed", "cancelled", "unchanged", "uncertain"]),
  uncertaintyProtected: Schema.optional(Schema.Boolean),
  model: Schema.optional(ModelSelectionSchema),
});
export type TitleStage = 1 | 2 | 3 | 4;
export function readTitleStage(thread: OrchestrationThread, stage: TitleStage) {
  const activity = thread.activities.findLast(
    (item) =>
      item.kind === "text-generation.title-stage" &&
      Schema.is(Stage)(item.payload) &&
      item.payload.stage === stage,
  );
  return activity && Schema.is(Stage)(activity.payload) ? activity.payload : null;
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
          ...(state === "started" ? { owner: crypto.randomUUID() } : {}),
        },
        turnId: null,
        createdAt,
      },
    })
    .pipe(Effect.asVoid);
}
