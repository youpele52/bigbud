import {
  CheckpointRef,
  CommandId,
  MessageId,
  ThreadId,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
} from "@bigbud/contracts";
import { Effect } from "effect";

import { isThinkingActivity } from "./ProviderRuntimeIngestion.processor.thinking.ts";
import { toTurnId } from "./ProviderRuntimeIngestion.helpers.ts";
import type { RuntimeProcessorServices } from "./ProviderRuntimeIngestion.processor.ts";

export function makeRuntimeProcessorEventHelpers(input: {
  readonly orchestrationEngine: RuntimeProcessorServices["orchestrationEngine"];
  readonly serverSettingsService: RuntimeProcessorServices["serverSettingsService"];
  readonly isGitRepoForThread: (threadId: ThreadId) => Effect.Effect<boolean>;
  readonly providerCommandId: (event: ProviderRuntimeEvent, tag: string) => CommandId;
}) {
  const appendActivities = Effect.fn("appendActivities")(function* (deps: {
    readonly event: ProviderRuntimeEvent;
    readonly threadId: ThreadId;
    readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  }) {
    const thinkingStreamingEnabled =
      !deps.activities.some(isThinkingActivity) ||
      (yield* input.serverSettingsService.getSettings.pipe(
        Effect.map((settings) => settings.enableThinkingStreaming),
        Effect.catch(() => Effect.succeed(false)),
      ));
    yield* Effect.forEach(
      deps.activities,
      (activity) =>
        thinkingStreamingEnabled || !isThinkingActivity(activity)
          ? input.orchestrationEngine
              .dispatch({
                type: "thread.activity.append",
                commandId: input.providerCommandId(deps.event, "thread-activity-append"),
                threadId: deps.threadId,
                activity,
                createdAt: activity.createdAt,
              })
              .pipe(Effect.asVoid)
          : Effect.void,
      { concurrency: 1, discard: true },
    );
  });

  const handleTurnDiffUpdated = Effect.fn("handleTurnDiffUpdated")(function* (deps: {
    readonly event: Extract<ProviderRuntimeEvent, { type: "turn.diff.updated" }>;
    readonly thread: {
      readonly id: ThreadId;
      readonly checkpoints: ReadonlyArray<{
        readonly turnId: string | null;
        readonly checkpointTurnCount: number;
      }>;
    };
    readonly now: string;
  }) {
    const turnId = toTurnId(deps.event.turnId);
    if (!turnId || !(yield* input.isGitRepoForThread(deps.thread.id))) {
      return;
    }

    if (deps.thread.checkpoints.some((c) => c.turnId === turnId)) {
      return;
    }

    const assistantMessageId = MessageId.makeUnsafe(
      `assistant:${deps.event.itemId ?? deps.event.turnId ?? deps.event.eventId}`,
    );
    const maxTurnCount = deps.thread.checkpoints.reduce(
      (max, c) => Math.max(max, c.checkpointTurnCount),
      0,
    );
    yield* input.orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: input.providerCommandId(deps.event, "thread-turn-diff-complete"),
      threadId: deps.thread.id,
      turnId,
      completedAt: deps.now,
      checkpointRef: CheckpointRef.makeUnsafe(`provider-diff:${deps.event.eventId}`),
      status: "missing",
      files: [],
      assistantMessageId,
      checkpointTurnCount: maxTurnCount + 1,
      createdAt: deps.now,
    });
  });

  return {
    appendActivities,
    handleTurnDiffUpdated,
  };
}
