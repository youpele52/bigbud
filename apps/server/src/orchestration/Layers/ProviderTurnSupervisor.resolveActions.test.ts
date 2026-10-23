import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { continuationFailed } from "./ProviderTurnSupervisor.continue.ts";
import { RECOVERY_NO_ACTIVITY_AFTER_WAKE_MS } from "./ProviderTurnSupervisor.policy.logic.ts";
import {
  observeTurnsAcrossSleep,
  recordTurnFailure,
  runRecoveryPass,
} from "./ProviderTurnSupervisor.recovery.ts";
import { resolveRecovery } from "./ProviderTurnSupervisor.resolve.ts";
import {
  failureAt,
  makeRecoveryHarness,
  messageId,
  recoveryTestLayer,
  SLEPT_AT_MS,
  threadId,
  WOKE_AT_MS,
  type RecoveryHarness,
  type RecoveryHarnessOptions,
} from "./ProviderTurnSupervisor.recovery.test.helpers.ts";

const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(recoveryTestLayer)) as Effect.Effect<A, E, never>;

const epoch = {
  epochId: 1,
  startedAtMs: SLEPT_AT_MS,
  endedAtMs: WOKE_AT_MS,
  durationMs: 600_000,
  sources: ["server-gap" as const],
};

const cutAtWake = (h: RecoveryHarness) =>
  Effect.gen(function* () {
    yield* h.seedRunningTurn;
    yield* h.sleepAndWake;
    h.endTurnWithError();
    yield* recordTurnFailure(h.ctx, failureAt(WOKE_AT_MS + 500));
  });

/** A turn that ran across the sleep and stayed silent: "No activity since wake". */
const noActivityPrompt = (options: RecoveryHarnessOptions = {}) =>
  Effect.gen(function* () {
    const h = yield* makeRecoveryHarness(options);
    yield* h.seedRunningTurn;
    yield* observeTurnsAcrossSleep(h.ctx, epoch);
    h.advance(RECOVERY_NO_ACTIVITY_AFTER_WAKE_MS);
    yield* runRecoveryPass(h.ctx);
    assert.strictEqual(h.thread().recovery?.reason, "no-activity-after-wake");
    return h;
  });

describe("a user's action is checked against the intent, not only the projection", () => {
  it.effect("a Continue on an intent that is already continuing keeps its continuation", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness({ continuationEnabled: false });
        yield* cutAtWake(h);
        yield* resolveRecovery(h.ctx, { threadId, messageId, action: "continue" });
        const first = yield* h.intent();
        assert.strictEqual(first.recoveryStatus, "continuing");
        assert.strictEqual(h.turnStarts().length, 1);
        // A stale projection still shows the prompt, and the user clicks Continue again.
        h.patchThread({ recovery: { ...h.thread().recovery!, status: "awaiting-user" } });
        yield* resolveRecovery(h.ctx, { threadId, messageId, action: "continue" });
        const after = yield* h.intent();
        assert.strictEqual(after.continuationMessageId, first.continuationMessageId);
        assert.strictEqual(after.revision, first.revision);
        assert.strictEqual(h.turnStarts().length, 1);
        // The notice is brought back in line with the intent.
        assert.strictEqual(h.thread().recovery?.status, "continuing");
      }),
    ),
  );

  it.effect("republishes a prompt whose publish failed, so it never stays hidden", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness({ continuationEnabled: false });
        h.failNextRecoverySets(Number.MAX_SAFE_INTEGER);
        yield* cutAtWake(h);
        assert.strictEqual((yield* h.intent()).recoveryStatus, "awaiting-user");
        assert.isNull(h.thread().recovery ?? null);
        h.failNextRecoverySets(0);
        yield* runRecoveryPass(h.ctx);
        assert.strictEqual(h.thread().recovery?.status, "awaiting-user");
        assert.strictEqual(h.thread().recovery?.reason, "interrupted-by-sleep");
        // In sync now: the next pass dispatches nothing.
        const dispatched = h.commands.length;
        yield* runRecoveryPass(h.ctx);
        assert.strictEqual(h.commands.length, dispatched);
        assert.strictEqual(h.turnStarts().length, 0);
      }),
    ),
  );
});

describe("the user's choices on a prompt", () => {
  it.effect("Retry from parked sends one user-authorized continuation", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* cutAtWake(h);
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          yield* continuationFailed(h.ctx, yield* h.intent(), "provider unavailable");
          yield* runRecoveryPass(h.ctx);
        }
        assert.strictEqual((yield* h.intent()).recoveryStatus, "parked");
        yield* resolveRecovery(h.ctx, { threadId, messageId, action: "retry" });
        const intent = yield* h.intent();
        assert.strictEqual(intent.recoveryStatus, "continuing");
        assert.isTrue(intent.detail.userAuthorized);
        // A user's try never counts toward parking.
        assert.strictEqual(intent.attemptCount, 3);
        assert.strictEqual(h.turnStarts().length, 4);
        assert.strictEqual(h.thread().recovery?.status, "continuing");
      }),
    ),
  );

  it.effect("Keep waiting restarts the awake clock and sends nothing", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* noActivityPrompt();
        yield* resolveRecovery(h.ctx, { threadId, messageId, action: "keep-waiting" });
        const waiting = yield* h.intent();
        assert.strictEqual(waiting.recoveryStatus, "observing");
        assert.strictEqual(waiting.detail.wokeAt, new Date(h.nowMs()).toISOString());
        assert.isUndefined(waiting.detail.reason);
        // Less than another 120 s of quiet: it keeps waiting instead of asking again.
        h.advance(RECOVERY_NO_ACTIVITY_AFTER_WAKE_MS / 2);
        yield* runRecoveryPass(h.ctx);
        assert.strictEqual((yield* h.intent()).recoveryStatus, "observing");
        assert.strictEqual(h.turnStarts().length, 0);
      }),
    ),
  );

  it.effect("Stop and continue stops the provider turn, then continues once", () =>
    provided(
      Effect.gen(function* () {
        let stopping: RecoveryHarness | undefined;
        const interrupts: string[] = [];
        const h = yield* noActivityPrompt({
          provider: {
            interruptTurn: (input) =>
              Effect.sync(() => {
                interrupts.push(String(input.turnId));
                stopping?.idleThread();
              }),
          },
        });
        stopping = h;
        yield* resolveRecovery(h.ctx, { threadId, messageId, action: "stop-and-continue" });
        assert.deepStrictEqual(interrupts, ["original-turn"]);
        const intent = yield* h.intent();
        assert.strictEqual(intent.recoveryStatus, "continuing");
        assert.strictEqual(intent.attemptCount, 0);
        assert.strictEqual(h.turnStarts().length, 1);
      }),
    ),
  );
});
