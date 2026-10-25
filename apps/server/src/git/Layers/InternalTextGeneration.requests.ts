import {
  CommandId,
  EventId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ThreadId,
} from "@bigbud/contracts";
import { Effect, Schema } from "effect";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import { resolveWorkspaceExecutionTargetId } from "../../workspace-target/workspaceTarget.ts";

export function sameTextGenerationWorkspace(
  before: OrchestrationThread,
  after: OrchestrationThread,
): boolean {
  return (
    before.projectId === after.projectId &&
    before.worktreePath === after.worktreePath &&
    resolveWorkspaceExecutionTargetId(before) === resolveWorkspaceExecutionTargetId(after)
  );
}

export const TEXT_GENERATION_REQUEST_KIND = "text-generation.retry-requested";
export const TEXT_GENERATION_REQUEST_STARTED = "text-generation.request-started";
export const TEXT_GENERATION_REQUEST_SETTLED = "text-generation.request-settled";
export const REQUEST_SETTLED_ID_PREFIX = "text-generation-request-settled:";

export const TextGenerationRequestContext = Schema.Struct({
  cwd: Schema.String,
  workspaceExecutionTargetId: Schema.String,
  projectId: Schema.String,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  title: Schema.String,
});
export const TextGenerationRequest = Schema.Struct({
  operation: Schema.Literals(["title", "summary"]),
  requestId: EventId,
  sourceActivityId: EventId,
  context: TextGenerationRequestContext,
});
export type TextGenerationRequest = typeof TextGenerationRequest.Type;

export function readTextGenerationRequest(
  activity: OrchestrationThreadActivity,
): TextGenerationRequest | null {
  return activity.kind === TEXT_GENERATION_REQUEST_KIND &&
    Schema.is(TextGenerationRequest)(activity.payload) &&
    activity.payload.requestId === activity.id
    ? activity.payload
    : null;
}

export function hasTextGenerationRequestStage(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  requestId: EventId,
  stage: "started" | "settled",
): boolean {
  const id =
    stage === "settled"
      ? `${REQUEST_SETTLED_ID_PREFIX}${requestId}`
      : `text-generation-request-started:${requestId}`;
  return activities.some((activity) => activity.id === id);
}

/** Persist ownership before provider work; an ambiguous started request must never be charged again automatically. */
export function recordTextGenerationRequestStage(
  engine: Pick<OrchestrationEngineShape, "dispatch">,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  stage: "started" | "settled",
) {
  const id =
    stage === "settled"
      ? `${REQUEST_SETTLED_ID_PREFIX}${activity.id}`
      : `text-generation-request-started:${activity.id}`;
  return engine
    .dispatch({
      type: "thread.activity.append",
      threadId,
      commandId: CommandId.makeUnsafe(`server:${id}`),
      createdAt: activity.createdAt,
      activity: {
        id: EventId.makeUnsafe(id),
        kind:
          stage === "settled" ? TEXT_GENERATION_REQUEST_SETTLED : TEXT_GENERATION_REQUEST_STARTED,
        tone: "info",
        summary: `Text generation request ${stage}`,
        // A fresh owner makes racing start claims conflict via existing command-receipt digests.
        payload: {
          requestId: activity.id,
          ...(stage === "started" ? { owner: crypto.randomUUID() } : {}),
        },
        turnId: null,
        createdAt: activity.createdAt,
      },
    })
    .pipe(Effect.asVoid);
}
