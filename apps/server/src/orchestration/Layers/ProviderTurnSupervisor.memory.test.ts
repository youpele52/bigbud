import { MessageId, type OrchestrationEvent } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { observeDomainEvent, observeRuntimeEvent } from "./ProviderTurnSupervisor.observe.ts";
import {
  makeRecoveryHarness,
  messageId,
  recoveryTestLayer,
  threadId,
  turnId,
  type RecoveryHarness,
} from "./ProviderTurnSupervisor.recovery.test.helpers.ts";
import {
  contentDelta,
  toolItem,
  turnCompleted,
  turnStarted,
} from "./ProviderTurnSupervisor.runtimeEvents.test.helpers.ts";
import { intentKeyString } from "./ProviderTurnSupervisor.state.ts";

const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(recoveryTestLayer)) as Effect.Effect<A, E, never>;

const iso = (ms: number) => new Date(ms).toISOString();

/** Every per-thread entry the coordinator keeps in memory for the test thread. */
function remembered(h: RecoveryHarness) {
  const { memory } = h.ctx;
  const prefix = `${threadId}\u0000`;
  return {
    turnTools: memory.turnTools.has(threadId),
    lastProgress: memory.lastProgressAtMs.has(threadId),
    lastCompleted: memory.lastCompletedAtMs.has(threadId),
    pendingFailure: memory.pendingFailures.has(threadId),
    inspections: [...memory.inspections.keys()].some((key) => key.startsWith(prefix)),
    notices: [...memory.unpublishedNotices.keys()].some((key) => key.startsWith(prefix)),
  };
}

const nothing = {
  turnTools: false,
  lastProgress: false,
  lastCompleted: false,
  pendingFailure: false,
  inspections: false,
  notices: false,
};

/** A running turn the coordinator watched from its start: progress, one finished tool. */
const watchedTurn = (h: RecoveryHarness) =>
  Effect.gen(function* () {
    yield* h.seedRunningTurn;
    const at = iso(h.nowMs());
    yield* observeRuntimeEvent(h.ctx, turnStarted(threadId, turnId, at));
    yield* observeRuntimeEvent(h.ctx, contentDelta(threadId, turnId, at));
    yield* observeRuntimeEvent(h.ctx, toolItem("item.started", threadId, turnId, "t1", "Test"));
    h.ctx.memory.inspections.set(intentKeyString(threadId, messageId), {
      atMs: h.nowMs(),
      revision: 1,
      outcome: "running",
    });
  });

describe("per-thread recovery memory is pruned, not only bounded", () => {
  it.effect("forgets a thread's evidence once its turn ends with nothing open", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* watchedTurn(h);
        yield* observeRuntimeEvent(h.ctx, toolItem("item.completed", threadId, turnId, "t1", "T"));
        yield* observeRuntimeEvent(h.ctx, turnCompleted(threadId, turnId, "completed"));
        assert.strictEqual((yield* h.intent()).disposition, "settled");
        assert.deepStrictEqual(remembered(h), nothing);
      }),
    ),
  );

  it.effect("keeps the evidence while a tool of the ended turn is still open", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* watchedTurn(h);
        yield* observeRuntimeEvent(h.ctx, turnCompleted(threadId, turnId, "interrupted"));
        assert.isTrue(remembered(h).turnTools);
        assert.deepStrictEqual([...h.ctx.memory.turnTools.get(threadId)!.open.keys()], ["t1"]);
      }),
    ),
  );

  it.effect("keeps the evidence while another intent of the thread is still open", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* watchedTurn(h);
        yield* observeRuntimeEvent(h.ctx, toolItem("item.completed", threadId, turnId, "t1", "T"));
        yield* h.intents.recordAccepted({
          threadId,
          messageId: MessageId.makeUnsafe("next-prompt"),
          provider: "claudeAgent",
          createdAt: iso(h.nowMs()),
        });
        yield* observeRuntimeEvent(h.ctx, turnCompleted(threadId, turnId, "completed"));
        assert.isTrue(remembered(h).lastCompleted);
        assert.isTrue(remembered(h).lastProgress);
      }),
    ),
  );

  it.effect("forgets everything, failed notices included, when the thread is deleted", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* watchedTurn(h);
        h.ctx.memory.unpublishedNotices.set(intentKeyString(threadId, messageId), {
          threadId,
          messageId,
        });
        h.ctx.memory.pendingFailures.set(threadId, {
          observation: {
            threadId,
            turnId,
            kind: "runtime-error",
            observedAtMs: h.nowMs(),
            detail: null,
          },
          messageId,
          heldMs: 0,
          lastCheckedAtMs: h.nowMs(),
        });
        yield* observeDomainEvent(h.ctx, {
          type: "thread.deleted",
          payload: { threadId, deletedAt: iso(h.nowMs()) },
        } as unknown as OrchestrationEvent);
        assert.deepStrictEqual(remembered(h), nothing);
      }),
    ),
  );
});
