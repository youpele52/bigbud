import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { observeTurnsAcrossSleep, runRecoveryPass } from "./ProviderTurnSupervisor.recovery.ts";
import { resolveRecovery } from "./ProviderTurnSupervisor.resolve.ts";
import { handleBackendStart } from "./ProviderTurnSupervisor.startup.ts";
import {
  failureAt,
  makeRecoveryHarness,
  messageId,
  recoveryTestLayer,
  SLEPT_AT_MS,
  threadId,
  WOKE_AT_MS,
} from "./ProviderTurnSupervisor.recovery.test.helpers.ts";
import { recordTurnFailure } from "./ProviderTurnSupervisor.recovery.ts";
import { RECOVERY_NO_ACTIVITY_AFTER_WAKE_MS } from "./ProviderTurnSupervisor.policy.logic.ts";

const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(recoveryTestLayer)) as Effect.Effect<A, E, never>;

const epoch = {
  epochId: 1,
  startedAtMs: SLEPT_AT_MS,
  endedAtMs: WOKE_AT_MS,
  durationMs: 600_000,
  sources: ["server-gap" as const],
};

describe("sleep recovery after a backend restart", () => {
  it.effect("a post-wake restart turns an uncertain turn into a prompt, not a silent stop", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* h.seedRunningTurn;
        // The old backend shut down gracefully: app teardown suspended the intent.
        yield* h.intents.suspendActiveForExit({ at: new Date(WOKE_AT_MS + 1_000).toISOString() });
        yield* handleBackendStart(h.ctx, {
          startReason: "resume-probe-restart",
          processStartedAtMs: WOKE_AT_MS + 5_000,
        });
        const intent = yield* h.intent();
        assert.strictEqual(intent.disposition, "active");
        assert.strictEqual(intent.recoveryStatus, "awaiting-user");
        assert.strictEqual(intent.detail.reason, "backend-restarted-after-wake");
        assert.strictEqual(h.thread().recovery?.reason, "backend-restarted-after-wake");
        assert.strictEqual(h.turnStarts().length, 0);
      }),
    ),
  );

  it.effect("shows the post-wake restart prompt on a thread outside the startup window", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness({ loadOnDemand: true });
        yield* h.seedRunningTurn;
        // The old backend's graceful stopAll persisted the session stopped and suspended the
        // intent. Nothing else keeps the thread operational, so the startup window skips it.
        h.patchThread({
          session: { ...h.thread().session!, status: "stopped", activeTurnId: null },
        });
        yield* h.intents.suspendActiveForExit({ at: new Date(WOKE_AT_MS + 1_000).toISOString() });
        assert.isFalse(h.loaded());
        yield* handleBackendStart(h.ctx, {
          startReason: "resume-probe-restart",
          processStartedAtMs: WOKE_AT_MS + 5_000,
        });
        assert.isTrue(h.loaded());
        assert.strictEqual((yield* h.intent()).recoveryStatus, "awaiting-user");
        assert.strictEqual(h.thread().recovery?.reason, "backend-restarted-after-wake");
        assert.strictEqual(h.turnStarts().length, 0);
      }),
    ),
  );

  it.effect("an ordinary restart keeps today's behavior: suspended, no prompt", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* h.seedRunningTurn;
        yield* handleBackendStart(h.ctx, {
          startReason: undefined,
          processStartedAtMs: WOKE_AT_MS + 5_000,
        });
        const intent = yield* h.intent();
        assert.strictEqual(intent.disposition, "suspended-for-exit");
        assert.isNull(h.thread().recovery);
        assert.strictEqual(h.commands.length, 0);
        // Nothing resumes a suspended intent.
        yield* runRecoveryPass(h.ctx);
        assert.strictEqual(h.turnStarts().length, 0);
      }),
    ),
  );

  it.effect("clears 'Resuming after sleep' when the app quit during a continuation", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* h.seedRunningTurn;
        yield* h.sleepAndWake;
        h.endTurnWithError();
        yield* recordTurnFailure(h.ctx, failureAt(WOKE_AT_MS + 500));
        assert.strictEqual(h.thread().recovery?.status, "continuing");
        // Quit: stopAll suspends every active intent, the projection still says continuing.
        yield* h.intents.suspendActiveForExit({ at: new Date(WOKE_AT_MS + 2_000).toISOString() });
        yield* handleBackendStart(h.ctx, {
          startReason: undefined,
          processStartedAtMs: WOKE_AT_MS + 60_000,
        });
        assert.isNull(h.thread().recovery ?? null);
        assert.strictEqual((yield* h.intent()).disposition, "suspended-for-exit");
        assert.strictEqual(h.turnStarts().length, 1);
      }),
    ),
  );

  it.effect("keeps a suspended prompt that waits for the user across an ordinary restart", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness({ continuationEnabled: false });
        yield* h.seedRunningTurn;
        yield* h.sleepAndWake;
        h.endTurnWithError();
        yield* recordTurnFailure(h.ctx, failureAt(WOKE_AT_MS + 500));
        assert.strictEqual(h.thread().recovery?.status, "awaiting-user");
        yield* h.intents.suspendActiveForExit({ at: new Date(WOKE_AT_MS + 2_000).toISOString() });
        yield* handleBackendStart(h.ctx, {
          startReason: undefined,
          processStartedAtMs: WOKE_AT_MS + 60_000,
        });
        assert.strictEqual(h.thread().recovery?.status, "awaiting-user");
      }),
    ),
  );

  it.effect("does not touch intents of this process after a restart", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* h.seedRunningTurn;
        yield* handleBackendStart(h.ctx, {
          startReason: "resume-probe-restart",
          processStartedAtMs: SLEPT_AT_MS - 600_000,
        });
        assert.strictEqual((yield* h.intent()).recoveryStatus, "none");
      }),
    ),
  );
});

describe("sleep recovery observation and user actions", () => {
  it.effect("observes an OpenCode V2 turn that inspection reports running", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness({ inspection: "running" });
        yield* h.seedRunningTurn;
        yield* observeTurnsAcrossSleep(h.ctx, epoch);
        assert.strictEqual((yield* h.intent()).recoveryStatus, "observing");
        yield* runRecoveryPass(h.ctx);
        assert.strictEqual((yield* h.intent()).recoveryStatus, "provider-continued");
        assert.strictEqual(h.turnStarts().length, 0);
      }),
    ),
  );

  it.effect("reports no activity after 120 s of awake time when nothing arrives", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* h.seedRunningTurn;
        yield* observeTurnsAcrossSleep(h.ctx, epoch);
        yield* runRecoveryPass(h.ctx);
        assert.strictEqual((yield* h.intent()).recoveryStatus, "observing");
        h.advance(RECOVERY_NO_ACTIVITY_AFTER_WAKE_MS);
        yield* runRecoveryPass(h.ctx);
        assert.strictEqual(h.thread().recovery?.reason, "no-activity-after-wake");
        assert.strictEqual(h.turnStarts().length, 0);
      }),
    ),
  );

  it.effect(
    "Continue sends a user-authorized continuation that does not count toward parking",
    () =>
      provided(
        Effect.gen(function* () {
          const h = yield* makeRecoveryHarness({ continuationEnabled: false });
          yield* h.seedRunningTurn;
          yield* h.sleepAndWake;
          h.endTurnWithError();
          yield* recordTurnFailure(h.ctx, failureAt(WOKE_AT_MS + 500));
          assert.strictEqual((yield* h.intent()).recoveryStatus, "awaiting-user");
          yield* resolveRecovery(h.ctx, { threadId, messageId, action: "continue" });
          assert.strictEqual(h.turnStarts().length, 1);
          const continuing = yield* h.intent();
          assert.strictEqual(continuing.recoveryStatus, "continuing");
          assert.strictEqual(continuing.attemptCount, 0);
        }),
      ),
  );

  it.effect("Dismiss settles the intent and nothing is sent", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness({ continuationEnabled: false });
        yield* h.seedRunningTurn;
        yield* h.sleepAndWake;
        h.endTurnWithError();
        yield* recordTurnFailure(h.ctx, failureAt(WOKE_AT_MS + 500));
        yield* resolveRecovery(h.ctx, { threadId, messageId, action: "dismiss" });
        assert.strictEqual((yield* h.intent()).disposition, "settled");
        assert.strictEqual(h.turnStarts().length, 0);
      }),
    ),
  );
});
