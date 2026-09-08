import { RuntimeTaskId, type EventId } from "@bigbud/contracts";
import { Effect } from "effect";

import { buildBigbudPlanTrackingFingerprint } from "../../../orchestration-tools/threadPlanTrackingTool.shared.ts";
import {
  claudeTaskPlanPayload,
  claudeTaskRuntimeUpdates,
  isClaudeTaskTool,
  reduceClaudeTaskState,
} from "./Adapter.tasks.ts";
import type { ClaudeSessionContext } from "./Adapter.types.ts";
import type { OfferClaudeRuntimeEvent } from "./Adapter.events.ts";
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
  readonly offerRuntimeEvent: OfferClaudeRuntimeEvent;
}) {
  if (!isClaudeTaskTool(deps.toolName)) return;
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
    const removalSource =
      deps.toolName === "TaskList"
        ? "taskList"
        : deps.toolName === "background_tasks_changed"
          ? "background"
          : deps.toolName === "task_notification"
            ? "lifecycle"
            : "observed";
    const sourcePriority =
      removalSource === "taskList"
        ? 3
        : removalSource === "background"
          ? 2
          : removalSource === "lifecycle"
            ? 4
            : 1;
    yield* deps.offerRuntimeEvent(deps.context, {
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
          sourcePriority,
          ...(removalSource === "taskList"
            ? { snapshotGeneration: deps.context.taskState.taskListGeneration }
            : removalSource === "background"
              ? { snapshotGeneration: deps.context.taskState.backgroundGeneration }
              : {}),
          providerMessageId: deps.toolUseId,
          observedOrdinal: deps.context.taskState.nextObservedOrdinal,
        },
        replacement: removalSource === "observed" ? "explicit" : "snapshot",
      },
      providerRefs: nativeProviderRefs(deps.context, { providerItemId: deps.toolUseId }),
    });
  }
  for (const task of claudeTaskRuntimeUpdates(deps.context.taskState, reduction.changedTaskIds)) {
    const stamp = yield* deps.makeEventStamp();
    yield* deps.offerRuntimeEvent(deps.context, {
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
  yield* deps.offerRuntimeEvent(deps.context, {
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
