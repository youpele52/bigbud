import { MessageId } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { makeEvent } from "../projector.test.helpers.ts";
import { observeDomainEvent, observeRuntimeEvent } from "./ProviderTurnSupervisor.observe.ts";
import { runRecoveryPass } from "./ProviderTurnSupervisor.recovery.ts";
import {
  makeRecoveryHarness,
  messageId,
  recoveryTestLayer,
  threadId,
  turnId,
  type RecoveryHarness,
} from "./ProviderTurnSupervisor.recovery.test.helpers.ts";
import {
  sessionExited,
  turnCompleted,
  turnStarted,
} from "./ProviderTurnSupervisor.runtimeEvents.test.helpers.ts";
import { PENDING_FAILURE_GRACE_MS } from "./ProviderTurnSupervisor.state.ts";

const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(recoveryTestLayer)) as Effect.Effect<A, E, never>;

/** The machine slept for ten minutes, ending now. */
const sleepEndingNow = (h: RecoveryHarness) =>
  h.sleep.recordEvidence({
    source: "server-gap",
    startedAtMs: h.nowMs() - 10 * 60_000,
    endedAtMs: h.nowMs(),
  });

/** Ticks the 5 s pass until the held failure has had its full awake-time grace. */
const passGrace = (h: RecoveryHarness) =>
  Effect.gen(function* () {
    for (let elapsed = 0; elapsed <= PENDING_FAILURE_GRACE_MS; elapsed += 5_000) {
      h.advance(5_000);
      yield* runRecoveryPass(h.ctx);
    }
  });

const assertNothingResumed = (h: RecoveryHarness) => {
  assert.strictEqual(h.turnStarts().length, 0);
  assert.isNull(h.thread().recovery ?? null);
};

describe("stale recovery intents are never resurrected", () => {
  it.effect(
    "an ordinary failure settles the intent; a post-wake exit hours later does nothing",
    () =>
      provided(
        Effect.gen(function* () {
          const h = yield* makeRecoveryHarness();
          yield* h.seedRunningTurn;
          h.endTurnWithError();
          yield* observeRuntimeEvent(h.ctx, turnCompleted(threadId, turnId, "failed"));
          assert.strictEqual((yield* h.intent()).disposition, "active");
          yield* passGrace(h);
          assert.strictEqual((yield* h.intent()).disposition, "settled");
          h.idleThread();
          h.advance(3 * 60 * 60_000);
          yield* sleepEndingNow(h);
          yield* observeRuntimeEvent(h.ctx, sessionExited(threadId));
          yield* runRecoveryPass(h.ctx);
          assertNothingResumed(h);
        }),
      ),
  );

  for (const state of ["interrupted", "cancelled"] as const) {
    it.effect(`a turn that ends ${state} settles its intent at once`, () =>
      provided(
        Effect.gen(function* () {
          const h = yield* makeRecoveryHarness();
          yield* h.seedRunningTurn;
          yield* observeRuntimeEvent(h.ctx, turnCompleted(threadId, turnId, state));
          assert.strictEqual((yield* h.intent()).disposition, "settled");
        }),
      ),
    );
  }

  it.effect("an interrupted old turn never settles a newer, still unbound intent", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        const newer = MessageId.makeUnsafe("newer-message");
        yield* h.intents.recordAccepted({
          threadId,
          messageId: newer,
          provider: "claudeAgent",
          createdAt: new Date(h.nowMs()).toISOString(),
        });
        yield* observeRuntimeEvent(h.ctx, turnCompleted(threadId, turnId, "interrupted"));
        const intent = yield* h.intents.get({ threadId, messageId: newer });
        assert.strictEqual(Option.getOrThrow(intent).disposition, "active");
      }),
    ),
  );

  it.effect("a turn that failed to start settles its intent", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* h.seedRunningTurn;
        yield* observeDomainEvent(
          h.ctx,
          makeEvent({
            sequence: 1,
            type: "thread.turn-start-failed",
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: new Date(h.nowMs()).toISOString(),
            commandId: null,
            payload: {
              threadId,
              messageId,
              context: "provider-turn-start",
              detail: "Provider turn start failed.",
              createdAt: new Date(h.nowMs()).toISOString(),
            },
          }),
        );
        assert.strictEqual((yield* h.intent()).disposition, "settled");
      }),
    ),
  );

  it.effect("a post-wake exit on an idle thread never continues an intent left active", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* h.seedRunningTurn;
        // The turn ended long ago without an event the coordinator saw; the thread is idle.
        h.idleThread();
        h.advance(3 * 60 * 60_000);
        yield* sleepEndingNow(h);
        yield* observeRuntimeEvent(h.ctx, sessionExited(threadId));
        yield* runRecoveryPass(h.ctx);
        assertNothingResumed(h);
        assert.strictEqual((yield* h.intent()).recoveryStatus, "none");
      }),
    ),
  );

  it.effect("a post-wake exit of a turn the coordinator saw running still continues", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* h.seedRunningTurn;
        yield* observeRuntimeEvent(h.ctx, turnStarted(threadId, turnId));
        yield* sleepEndingNow(h);
        // Ingestion already applied the exit; the coordinator's own tracking still knows.
        h.idleThread();
        yield* observeRuntimeEvent(h.ctx, sessionExited(threadId));
        assert.strictEqual(h.turnStarts().length, 1);
        assert.strictEqual((yield* h.intent()).recoveryStatus, "continuing");
      }),
    ),
  );
});

describe("held failures count awake time only", () => {
  it.effect("a failure seen just before suspend meets the epoch that arrives after wake", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* h.seedRunningTurn;
        h.endTurnWithError();
        const failedAtMs = h.nowMs();
        yield* observeRuntimeEvent(h.ctx, turnCompleted(threadId, turnId, "failed"));
        // The machine sleeps for ten minutes. At wake the tick fires before the evidence.
        h.advance(10 * 60_000);
        yield* runRecoveryPass(h.ctx);
        assert.strictEqual((yield* h.intent()).disposition, "active");
        yield* h.sleep.recordEvidence({
          source: "server-gap",
          startedAtMs: failedAtMs + 1_000,
          endedAtMs: h.nowMs(),
        });
        yield* runRecoveryPass(h.ctx);
        assert.strictEqual(h.turnStarts().length, 1);
        assert.strictEqual((yield* h.intent()).recoveryStatus, "continuing");
      }),
    ),
  );
});
