import { EventId } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { observeRuntimeEvent } from "./ProviderTurnSupervisor.observe.ts";
import { RECOVERY_NO_ACTIVITY_AFTER_WAKE_MS } from "./ProviderTurnSupervisor.policy.logic.ts";
import {
  observeTurnsAcrossSleep,
  recordTurnFailure,
  runRecoveryPass,
} from "./ProviderTurnSupervisor.recovery.ts";
import {
  failureAt,
  makeRecoveryHarness,
  recoveryTestLayer,
  SLEPT_AT_MS,
  threadId,
  turnId,
  WOKE_AT_MS,
  type RecoveryHarness,
} from "./ProviderTurnSupervisor.recovery.test.helpers.ts";
import { contentDelta } from "./ProviderTurnSupervisor.runtimeEvents.test.helpers.ts";

const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(recoveryTestLayer)) as Effect.Effect<A, E, never>;

const epoch = {
  epochId: 1,
  startedAtMs: SLEPT_AT_MS,
  endedAtMs: WOKE_AT_MS,
  durationMs: 600_000,
  sources: ["server-gap" as const],
};

/** The turn asked for an approval that nobody has answered yet. */
const awaitApproval = (h: RecoveryHarness) =>
  h.patchThread({
    activities: [
      {
        id: EventId.makeUnsafe("approval"),
        tone: "approval",
        kind: "approval.requested",
        summary: "Run deploy?",
        payload: { requestId: "approval-1" },
        turnId,
        createdAt: new Date(SLEPT_AT_MS - 5_000).toISOString(),
      },
    ],
  });

describe("progress is dated by the provider, not by when the coordinator read it", () => {
  it.effect("progress buffered at wake is not the provider continuing on its own", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* h.seedRunningTurn;
        yield* h.sleepAndWake;
        // The delta was produced right at wake but waited 9 s behind the coordinator.
        h.advance(9_000);
        yield* observeRuntimeEvent(
          h.ctx,
          contentDelta(threadId, turnId, new Date(WOKE_AT_MS + 500).toISOString()),
        );
        h.endTurnWithError();
        yield* recordTurnFailure(h.ctx, failureAt(h.nowMs()));
        assert.strictEqual(h.turnStarts().length, 1);
        assert.strictEqual((yield* h.intent()).recoveryStatus, "continuing");
      }),
    ),
  );

  it.effect("progress the provider produced after wake still shows it continued", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* h.seedRunningTurn;
        yield* h.sleepAndWake;
        h.advance(9_000);
        yield* observeRuntimeEvent(
          h.ctx,
          contentDelta(threadId, turnId, new Date(WOKE_AT_MS + 8_000).toISOString()),
        );
        h.endTurnWithError();
        yield* recordTurnFailure(h.ctx, failureAt(h.nowMs()));
        assert.strictEqual(h.turnStarts().length, 0);
        assert.strictEqual((yield* h.intent()).recoveryStatus, "provider-continued");
      }),
    ),
  );
});

describe("a turn waiting for the user is not silent", () => {
  it.effect("a turn waiting for an approval across the sleep is never 'no activity'", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* h.seedRunningTurn;
        awaitApproval(h);
        yield* observeTurnsAcrossSleep(h.ctx, epoch);
        h.advance(RECOVERY_NO_ACTIVITY_AFTER_WAKE_MS);
        yield* runRecoveryPass(h.ctx);
        assert.strictEqual((yield* h.intent()).recoveryStatus, "none");
        assert.isNull(h.thread().recovery ?? null);
        assert.strictEqual(h.turnStarts().length, 0);
      }),
    ),
  );

  it.effect("an observed turn that then waits for an approval counts as still working", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* makeRecoveryHarness();
        yield* h.seedRunningTurn;
        yield* observeTurnsAcrossSleep(h.ctx, epoch);
        assert.strictEqual((yield* h.intent()).recoveryStatus, "observing");
        awaitApproval(h);
        h.advance(RECOVERY_NO_ACTIVITY_AFTER_WAKE_MS);
        yield* runRecoveryPass(h.ctx);
        assert.strictEqual((yield* h.intent()).recoveryStatus, "provider-continued");
        assert.notStrictEqual(h.thread().recovery?.reason, "no-activity-after-wake");
        assert.strictEqual(h.turnStarts().length, 0);
      }),
    ),
  );
});
