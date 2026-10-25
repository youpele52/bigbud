import { MessageId, TurnId } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { observeRuntimeEvent } from "./ProviderTurnSupervisor.observe.ts";
import { recordTurnFailure, runRecoveryPass } from "./ProviderTurnSupervisor.recovery.ts";
import {
  failureAt,
  makeRecoveryHarness,
  recoveryTestLayer,
  threadId,
  turnId,
  WOKE_AT_MS,
} from "./ProviderTurnSupervisor.recovery.test.helpers.ts";
import { turnCompleted, turnStarted } from "./ProviderTurnSupervisor.runtimeEvents.test.helpers.ts";

const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(recoveryTestLayer)) as Effect.Effect<A, E, never>;

const queued = MessageId.makeUnsafe("queued-prompt");
const iso = (ms: number) => new Date(ms).toISOString();

describe("a completed turn settles only its own intent", () => {
  it.effect("a normally completed turn settles its intent", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* h.seedRunningTurn;
        yield* observeRuntimeEvent(h.ctx, turnCompleted(threadId, turnId, "completed"));
        assert.strictEqual((yield* h.intent()).disposition, "settled");
      }),
    ),
  );

  it.effect("the previous turn's late completion leaves a queued prompt's intent open", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* h.seedRunningTurn;
        yield* observeRuntimeEvent(h.ctx, turnStarted(threadId, turnId, iso(h.nowMs() - 60_000)));
        // Ingestion already completed turn A and flushed the queued prompt B.
        const at = iso(h.nowMs());
        yield* h.intents.settleSupersededByTurnStart({ threadId, messageId: queued, at });
        yield* h.intents.recordAccepted({
          threadId,
          messageId: queued,
          provider: "claudeAgent",
          createdAt: at,
        });
        // The coordinator reads A's completion only now.
        yield* observeRuntimeEvent(h.ctx, turnCompleted(threadId, turnId, "completed", at));
        const intent = Option.getOrThrow(yield* h.intents.get({ threadId, messageId: queued }));
        assert.strictEqual(intent.disposition, "active");
      }),
    ),
  );

  it.effect("an unbound intent settles when its own turn completes before it binds", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        const own = TurnId.makeUnsafe("queued-turn");
        yield* h.intents.recordAccepted({
          threadId,
          messageId: queued,
          provider: "claudeAgent",
          createdAt: iso(h.nowMs()),
        });
        yield* observeRuntimeEvent(h.ctx, turnStarted(threadId, own, iso(h.nowMs() + 100)));
        yield* observeRuntimeEvent(
          h.ctx,
          turnCompleted(threadId, own, "completed", iso(h.nowMs() + 200)),
        );
        const intent = Option.getOrThrow(yield* h.intents.get({ threadId, messageId: queued }));
        assert.strictEqual(intent.disposition, "settled");
      }),
    ),
  );

  it.effect("the cut turn's late completion never settles the seeded continuation", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* h.seedRunningTurn;
        yield* observeRuntimeEvent(h.ctx, turnStarted(threadId, turnId, iso(WOKE_AT_MS - 700_000)));
        yield* h.sleepAndWake;
        h.endTurnWithError();
        yield* recordTurnFailure(h.ctx, failureAt(WOKE_AT_MS + 500));
        const original = yield* h.intent();
        assert.strictEqual(original.recoveryStatus, "continuing");
        const continuationId = original.continuationMessageId!;
        // The original turn's completion arrives after the continuation was seeded.
        yield* observeRuntimeEvent(
          h.ctx,
          turnCompleted(threadId, turnId, "completed", iso(h.nowMs())),
        );
        const seeded = yield* h.intents.get({ threadId, messageId: continuationId });
        assert.strictEqual(Option.getOrThrow(seeded).disposition, "active");
        // So the continuation still binds, and "Resuming after sleep" clears at once.
        const attempt = yield* h.attempts.markMayHaveBeenSent({
          threadId,
          messageId: continuationId,
          provider: "claudeAgent",
          payloadDigest: "c",
          at: iso(h.nowMs()),
        });
        assert.isTrue(Option.isSome(attempt));
        yield* h.attempts.acknowledgeWith(
          {
            attemptId: Option.getOrThrow(attempt).attemptId,
            threadId,
            messageId: continuationId,
            turnId: TurnId.makeUnsafe("continuation-turn"),
            provider: "claudeAgent",
            at: iso(h.nowMs()),
          },
          Effect.void,
        );
        yield* runRecoveryPass(h.ctx);
        assert.strictEqual((yield* h.intent()).recoveryStatus, "continued");
        assert.isNull(h.thread().recovery ?? null);
      }),
    ),
  );
});
