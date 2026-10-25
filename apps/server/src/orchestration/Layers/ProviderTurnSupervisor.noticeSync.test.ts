import { MessageId } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { continuationFailed } from "./ProviderTurnSupervisor.continue.ts";
import { recordTurnFailure, runRecoveryPass } from "./ProviderTurnSupervisor.recovery.ts";
import { resolveRecovery } from "./ProviderTurnSupervisor.resolve.ts";
import {
  failureAt,
  makeRecoveryHarness,
  messageId,
  recoveryTestLayer,
  threadId,
  WOKE_AT_MS,
} from "./ProviderTurnSupervisor.recovery.test.helpers.ts";

const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(recoveryTestLayer)) as Effect.Effect<A, E, never>;

describe("the continuation never runs after the user's own message", () => {
  it.effect("a message between the idle check and dispatch drops the continuation", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        const userMessage = MessageId.makeUnsafe("user-follow-up");
        h.setTurnStartInterceptor(() =>
          Effect.gen(function* () {
            // The user's turn start commits first and settles the cut turn's intent; the
            // engine then refuses the continuation instead of queueing it behind the user.
            yield* h.intents.settleSupersededByTurnStart({
              threadId,
              messageId: userMessage,
              at: new Date(h.nowMs()).toISOString(),
            });
            yield* h.intents.recordAccepted({
              threadId,
              messageId: userMessage,
              provider: "claudeAgent",
              createdAt: new Date(h.nowMs()).toISOString(),
            });
            h.patchThread({
              session: { ...h.thread().session!, status: "running", activeTurnId: null },
            });
            return false;
          }).pipe(Effect.orDie),
        );
        yield* h.seedRunningTurn;
        yield* h.sleepAndWake;
        h.endTurnWithError();
        yield* recordTurnFailure(h.ctx, failureAt(WOKE_AT_MS + 500));
        assert.strictEqual(h.turnStarts().length, 1);
        const original = yield* h.intent();
        assert.strictEqual(original.disposition, "settled");
        // "Resuming after sleep" does not stay behind.
        assert.isNull(h.thread().recovery ?? null);
        // The continuation's own seeded intent does not linger either.
        const seeded = yield* h.intents.get({
          threadId,
          messageId: original.continuationMessageId!,
        });
        assert.strictEqual(Option.getOrThrow(seeded).disposition, "settled");
        // The user's turn is untouched, and nothing retries later.
        const user = yield* h.intents.get({ threadId, messageId: userMessage });
        assert.strictEqual(Option.getOrThrow(user).disposition, "active");
        h.advance(60_000);
        yield* runRecoveryPass(h.ctx);
        assert.strictEqual(h.turnStarts().length, 1);
      }),
    ),
  );

  it.effect("a refusal while the original still waits counts as a failed continuation", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        h.setTurnStartInterceptor(() => Effect.succeed(false));
        yield* h.seedRunningTurn;
        yield* h.sleepAndWake;
        h.endTurnWithError();
        yield* recordTurnFailure(h.ctx, failureAt(WOKE_AT_MS + 500));
        const intent = yield* h.intent();
        assert.strictEqual(intent.disposition, "active");
        assert.strictEqual(intent.recoveryStatus, "interrupted-by-sleep");
        assert.strictEqual(intent.detail.reason, "continuation-failed");
        assert.strictEqual(intent.attemptCount, 1);
      }),
    ),
  );
});

describe("each try is its own visible state", () => {
  it.effect("a user's repeated Continue shows a new try each time and never parks", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness({ continuationEnabled: false });
        yield* h.seedRunningTurn;
        yield* h.sleepAndWake;
        h.endTurnWithError();
        yield* recordTurnFailure(h.ctx, failureAt(WOKE_AT_MS + 500));
        const shown: Array<[string | undefined, number | undefined]> = [];
        for (let round = 0; round < 2; round += 1) {
          yield* resolveRecovery(h.ctx, { threadId, messageId, action: "continue" });
          shown.push([h.thread().recovery?.status, h.thread().recovery?.attempt]);
          yield* continuationFailed(h.ctx, yield* h.intent(), "provider unavailable");
          shown.push([h.thread().recovery?.status, h.thread().recovery?.attempt]);
        }
        assert.deepStrictEqual(shown, [
          ["continuing", 1],
          ["awaiting-user", 1],
          ["continuing", 2],
          ["awaiting-user", 2],
        ]);
        // User-authorized tries never count toward parking.
        assert.strictEqual((yield* h.intent()).attemptCount, 0);
      }),
    ),
  );
});

describe("a user's action on a prompt that moved on", () => {
  it.effect("clears the 'continuing' state the decider projected when the intent was revoked", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness({ continuationEnabled: false });
        yield* h.seedRunningTurn;
        yield* h.sleepAndWake;
        h.endTurnWithError();
        yield* recordTurnFailure(h.ctx, failureAt(WOKE_AT_MS + 500));
        const prompt = h.thread().recovery!;
        assert.strictEqual(prompt.status, "awaiting-user");
        // The user clicked Continue: the decider projects "continuing" right away...
        h.patchThread({ recovery: { ...prompt, status: "continuing" } });
        // ...but a Stop revoked the intent before the coordinator acted.
        yield* h.intents.revokeForThread({ threadId, at: new Date(h.nowMs()).toISOString() });
        yield* resolveRecovery(h.ctx, { threadId, messageId, action: "continue" });
        assert.isNull(h.thread().recovery ?? null);
        assert.strictEqual(h.turnStarts().length, 0);
      }),
    ),
  );

  it.effect("clears it as well when the intent no longer exists", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        const gone = MessageId.makeUnsafe("pruned-message");
        h.patchThread({
          recovery: {
            status: "continuing",
            reason: "interrupted-by-sleep",
            toolSummary: null,
            attempt: 0,
            provider: "claudeAgent",
            messageId: gone,
            updatedAt: new Date(h.nowMs()).toISOString(),
          },
        });
        yield* resolveRecovery(h.ctx, { threadId, messageId: gone, action: "retry" });
        assert.isNull(h.thread().recovery ?? null);
      }),
    ),
  );
});
