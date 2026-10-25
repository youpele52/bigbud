import type { OrchestrationThread } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { Clock, Effect } from "effect";

import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { makeProviderFailureHandlers } from "./ProviderCommandReactorHandlers.failures.ts";

/** A start that has neither bound nor failed by now is failed so its queue can move on. */
export const PENDING_TURN_START_TIMEOUT_MS = 10 * 60_000;

const gateKey = (thread: OrchestrationThread) =>
  `${thread.id}\u0000${thread.pendingTurnStart?.messageId ?? ""}`;

/**
 * Ages each pending start from when this process first saw it, on the server clock, so client
 * clock skew in `requestedAt` cannot fail a start early. Forgets gates that have cleared.
 */
export function selectStalePendingTurnStarts(input: {
  readonly threads: ReadonlyArray<OrchestrationThread>;
  readonly firstSeenAt: Map<string, number>;
  readonly nowMs: number;
  readonly timeoutMs?: number;
}): ReadonlyArray<OrchestrationThread> {
  const timeoutMs = input.timeoutMs ?? PENDING_TURN_START_TIMEOUT_MS;
  const gated = input.threads.filter(
    (thread) => thread.pendingTurnStart != null && thread.deletedAt == null,
  );
  const live = new Set(gated.map(gateKey));
  for (const key of input.firstSeenAt.keys()) {
    if (!live.has(key)) input.firstSeenAt.delete(key);
  }
  return gated.filter((thread) => {
    const key = gateKey(thread);
    const seenAt = input.firstSeenAt.get(key);
    if (seenAt === undefined) {
      input.firstSeenAt.set(key, input.nowMs);
      return false;
    }
    return input.nowMs - seenAt >= timeoutMs;
  });
}

/** One watchdog pass: record a failed start for every gate older than the timeout. */
export const makeTurnStartWatchdogPass = (orchestrationEngine: OrchestrationEngineShape) => {
  const firstSeenAt = new Map<string, number>();
  const { recordTurnStartFailure } = makeProviderFailureHandlers(orchestrationEngine);
  return Effect.fn("turnStartWatchdogPass")(function* () {
    const readModel = yield* orchestrationEngine.getReadModel();
    const stale = selectStalePendingTurnStarts({
      threads: readModel.threads,
      firstSeenAt,
      nowMs: yield* Clock.currentTimeMillis,
    });
    for (const thread of stale) {
      const messageId = thread.pendingTurnStart!.messageId;
      yield* Effect.logWarning("failing a turn start that neither bound nor failed", {
        threadId: thread.id,
        messageId,
      });
      yield* recordTurnStartFailure({
        threadId: thread.id,
        context: "provider-turn-start",
        detail: "The provider did not start this turn within 10 minutes.",
        failureClass: "unknown",
        createdAt: new Date().toISOString(),
        messageId,
      });
      firstSeenAt.delete(gateKey(thread));
    }
  });
};
