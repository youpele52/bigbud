import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Duration, Effect, Ref } from "effect";

import { waitForReadModelCondition } from "../../orchestration/Layers/readModelSettle.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ThreadRetentionRepositoryShape } from "../../persistence/Services/ThreadRetentionRepository.ts";

export function settleRetentionDelete(input: {
  readonly threadId: ThreadId;
  readonly orchestration: OrchestrationEngineShape;
  readonly timeoutMs: number;
}) {
  return Effect.gen(function* () {
    const seenPending = yield* Ref.make(false);
    return yield* waitForReadModelCondition({
      check: input.orchestration.getReadModel().pipe(
        Effect.flatMap((model) =>
          Effect.gen(function* () {
            const thread = model.threads.find((candidate) => candidate.id === input.threadId);
            if (!thread || thread.deletedAt !== null) {
              return { done: true as const, value: "deleted" as const };
            }
            if (thread.deletingAt !== null) {
              yield* Ref.set(seenPending, true);
              return { done: false as const };
            }
            if (yield* Ref.get(seenPending)) {
              return { done: true as const, value: "skipped" as const };
            }
            return { done: false as const };
          }),
        ),
      ),
      events: input.orchestration.streamDomainEvents,
      timeout: Duration.millis(input.timeoutMs),
      onTimeout: "pending" as const,
    });
  });
}

export const settleRetentionCleanup = Effect.fn("ThreadRetention.settleCleanup")(function* (input: {
  readonly commandId: string;
  readonly repository: Pick<ThreadRetentionRepositoryShape, "readCleanupState">;
  readonly timeoutMs: number;
}) {
  const deadline = Date.now() + input.timeoutMs;
  for (;;) {
    const state = yield* input.repository.readCleanupState(input.commandId);
    if (state !== "pending" || Date.now() >= deadline) return state;
    yield* Effect.sleep(Duration.millis(Math.min(2_000, Math.max(1, deadline - Date.now()))));
  }
});
