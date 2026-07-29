import { RuntimeTaskId, type EventId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect } from "effect";

import { buildBigbudPlanTrackingFingerprint } from "../../../orchestration-tools/threadPlanTrackingTool.shared.ts";
import {
  claudeTaskPlanPayload,
  claudeTaskRuntimeUpdates,
  reduceClaudeTaskState,
} from "./Adapter.tasks.ts";
import type { ClaudeSessionContext } from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import { nativeProviderRefs } from "./Adapter.utils.ts";

export const updateClaudeTaskPlan = Effect.fn("updateClaudeTaskPlan")(function* (deps: {
  readonly context: ClaudeSessionContext;
  readonly toolUseId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly authoritativeSnapshot?: boolean;
  readonly now: string;
  readonly makeEventStamp: () => Effect.Effect<{ eventId: EventId; createdAt: string }>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
}) {
  if (!deps.context.modernTaskExposure && deps.toolName !== "TodoWrite") return;
  const reduction = reduceClaudeTaskState({
    state: deps.context.taskState,
    toolUseId: deps.toolUseId,
    toolName: deps.toolName,
    value: deps.input,
    updatedAt: deps.now,
    ...(deps.authoritativeSnapshot === true ? { authoritativeSnapshot: true } : {}),
    ...(deps.context.turnState?.turnId ? { turnId: deps.context.turnState.turnId } : {}),
  });
  if (!reduction.changed) {
    return;
  }

  const turnId = deps.context.turnState?.turnId;
  for (const taskId of reduction.removedTaskIds) {
    const stamp = yield* deps.makeEventStamp();
    const removalSource = deps.toolName === "TaskList" ? "taskList" : "background";
    yield* deps.offerRuntimeEvent({
      type: "task.removed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: deps.context.session.threadId,
      ...(turnId ? { turnId } : {}),
      payload: {
        taskId: RuntimeTaskId.makeUnsafe(taskId),
        source: removalSource,
        freshness: {
          sessionEpoch: deps.context.taskState.sessionEpoch,
          sourcePriority: removalSource === "taskList" ? 3 : 2,
          snapshotGeneration:
            removalSource === "taskList"
              ? deps.context.taskState.taskListGeneration
              : deps.context.taskState.backgroundGeneration,
          providerMessageId: deps.toolUseId,
          observedOrdinal: deps.context.taskState.nextObservedOrdinal,
        },
        replacement: "snapshot",
      },
      providerRefs: nativeProviderRefs(deps.context, { providerItemId: deps.toolUseId }),
    });
  }
  for (const task of claudeTaskRuntimeUpdates(deps.context.taskState, reduction.changedTaskIds)) {
    const stamp = yield* deps.makeEventStamp();
    yield* deps.offerRuntimeEvent({
      type: "task.updated",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: deps.context.session.threadId,
      ...(turnId ? { turnId } : {}),
      payload: task,
      providerRefs: nativeProviderRefs(deps.context, { providerItemId: deps.toolUseId }),
    });
  }
  const payload = claudeTaskPlanPayload(
    deps.context.taskState,
    deps.authoritativeSnapshot === true || reduction.removedTaskIds.length > 0,
  );
  if (!turnId || !payload) {
    return;
  }
  const fingerprint = buildBigbudPlanTrackingFingerprint(turnId, payload);
  if (deps.context.lastPlanFingerprint === fingerprint) {
    return;
  }
  deps.context.lastPlanFingerprint = fingerprint;

  const stamp = yield* deps.makeEventStamp();
  yield* deps.offerRuntimeEvent({
    type: "turn.plan.updated",
    eventId: stamp.eventId,
    provider: PROVIDER,
    createdAt: stamp.createdAt,
    threadId: deps.context.session.threadId,
    turnId,
    payload,
    providerRefs: nativeProviderRefs(deps.context, { providerItemId: deps.toolUseId }),
  });
});
