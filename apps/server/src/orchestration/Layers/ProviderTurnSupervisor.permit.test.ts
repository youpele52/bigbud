import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";

import type { PersistenceSqlError } from "../../persistence/Errors.ts";
import { ProviderValidationError } from "../../provider/Errors.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { makeProviderTurnSupervisor } from "./ProviderTurnSupervisor.ts";
import type { InspectionOutcome } from "./ProviderTurnSupervisor.policy.logic.ts";
import { RECOVERY_NO_ACTIVITY_AFTER_WAKE_MS } from "./ProviderTurnSupervisor.policy.logic.ts";
import {
  observeTurnsAcrossSleep,
  recordTurnFailure,
  runRecoveryPass,
} from "./ProviderTurnSupervisor.recovery.ts";
import {
  failureAt,
  makeRecoveryHarness,
  messageId,
  recoveryTestLayer,
  SLEPT_AT_MS,
  threadId,
  turnId,
  WOKE_AT_MS,
  type RecoveryHarnessOptions,
} from "./ProviderTurnSupervisor.recovery.test.helpers.ts";
import { resolveRecovery } from "./ProviderTurnSupervisor.resolve.ts";
import { turnCompleted } from "./ProviderTurnSupervisor.runtimeEvents.test.helpers.ts";
import { RECOVERY_INSPECTION_INTERVAL_MS } from "./ProviderTurnSupervisor.state.ts";

const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(recoveryTestLayer)) as Effect.Effect<A, E, never>;

const epoch = {
  epochId: 1,
  startedAtMs: SLEPT_AT_MS,
  endedAtMs: WOKE_AT_MS,
  durationMs: 600_000,
  sources: ["server-gap" as const],
};

/** Polls with real time until `check` holds, or gives up after about two seconds. */
const eventually = <E>(check: Effect.Effect<boolean, E>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (yield* check) return true;
      yield* Effect.sleep("10 millis");
    }
    return false;
  });

describe("provider calls run outside the coordinator's permit", () => {
  it.live("a slow inspection never holds up event observation", () =>
    provided(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
          const gate = yield* Deferred.make<void>();
          let blocking = false;
          let blockedInspections = 0;
          const h = yield* makeRecoveryHarness({
            runtimeEvents: Stream.fromQueue(events),
            inspect: () =>
              blocking
                ? Effect.sync(() => (blockedInspections += 1)).pipe(
                    Effect.andThen(Deferred.await(gate)),
                    Effect.as<InspectionOutcome>("running"),
                  )
                : Effect.succeed("unavailable"),
          });
          yield* h.seedRunningTurn;
          yield* observeTurnsAcrossSleep(h.ctx, epoch);
          const supervisor = yield* makeProviderTurnSupervisor({
            nowMs: h.nowMs,
            continuationEnabled: true,
            processStartedAtMs: SLEPT_AT_MS - 60 * 60_000,
          }).pipe(
            Effect.provideService(OrchestrationEngineService, h.ctx.engine),
            Effect.provideService(ProviderService, h.ctx.providerService),
          );
          yield* supervisor.start();
          // The next pass inspects again, and the provider takes its time to answer.
          h.advance(RECOVERY_INSPECTION_INTERVAL_MS + 1_000);
          blocking = true;
          const pass = yield* Effect.forkChild(supervisor.runPass);
          assert.isTrue(yield* eventually(Effect.sync(() => blockedInspections > 0)));
          // Meanwhile the turn completes: the coordinator observes it at once.
          yield* Queue.offer(
            events,
            turnCompleted(threadId, turnId, "completed", new Date(h.nowMs()).toISOString()),
          );
          const settled = yield* eventually(
            h.intent().pipe(Effect.map((intent) => intent.disposition === "settled")),
          );
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(pass);
          assert.isTrue(settled);
          // The inspection's stale "running" never moved the settled intent.
          const intent = yield* h.intent();
          assert.strictEqual(intent.disposition, "settled");
          assert.strictEqual(intent.recoveryStatus, "observing");
          assert.isNull(h.thread().recovery ?? null);
        }),
      ),
    ),
  );

  it.effect("a revision change during inspection prevents the stale action", () =>
    provided(
      Effect.gen(function* () {
        let duringInspection: Effect.Effect<void, PersistenceSqlError> | null = null;
        const h = yield* makeRecoveryHarness({
          inspect: () =>
            (duringInspection ?? Effect.void).pipe(
              Effect.orDie,
              Effect.as<InspectionOutcome>("unavailable"),
            ),
        });
        yield* h.sleep.recordDesktopHint({
          kind: "offline",
          sequence: 1,
          occurredAt: WOKE_AT_MS,
          online: false,
        });
        yield* h.seedRunningTurn;
        yield* h.sleepAndWake;
        h.endTurnWithError();
        yield* recordTurnFailure(h.ctx, failureAt(WOKE_AT_MS + 500));
        assert.strictEqual(h.thread().recovery?.status, "interrupted-by-sleep");
        // While the provider is asked, the user sends a message: recovery is settled and the
        // notice cleared. The pass must not republish the state it read before.
        duringInspection = Effect.gen(function* () {
          yield* h.intents.settleRecoveringForThread({
            threadId,
            at: new Date(h.nowMs()).toISOString(),
          });
          h.patchThread({ recovery: null });
        });
        h.advance(RECOVERY_INSPECTION_INTERVAL_MS + 1_000);
        yield* runRecoveryPass(h.ctx);
        assert.strictEqual((yield* h.intent()).disposition, "settled");
        assert.isNull(h.thread().recovery ?? null);
        assert.strictEqual(h.turnStarts().length, 0);
      }),
    ),
  );
});

/** A turn that ran across the sleep and stayed silent: "No activity since wake". */
const noActivityPrompt = (options: RecoveryHarnessOptions) =>
  Effect.gen(function* () {
    const h = yield* makeRecoveryHarness(options);
    yield* h.seedRunningTurn;
    yield* observeTurnsAcrossSleep(h.ctx, epoch);
    h.advance(RECOVERY_NO_ACTIVITY_AFTER_WAKE_MS);
    yield* runRecoveryPass(h.ctx);
    const prompt = h.thread().recovery!;
    assert.strictEqual(prompt.reason, "no-activity-after-wake");
    // The user chose Stop and continue; the decider projects "continuing" at once.
    h.patchThread({ recovery: { ...prompt, status: "continuing" } });
    return h;
  });

describe("Stop and continue sends nothing unless the provider stopped", () => {
  it.effect("a failed stop leaves the prompt asking the user", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* noActivityPrompt({
          provider: {
            interruptTurn: () =>
              Effect.fail(new ProviderValidationError({ operation: "interrupt", issue: "no" })),
            stopSession: () =>
              Effect.fail(new ProviderValidationError({ operation: "stop", issue: "failed" })),
          },
        });
        yield* resolveRecovery(h.ctx, { threadId, messageId, action: "stop-and-continue" });
        assert.strictEqual(h.turnStarts().length, 0);
        assert.strictEqual((yield* h.intent()).recoveryStatus, "awaiting-user");
        assert.strictEqual(h.thread().recovery?.status, "awaiting-user");
      }),
    ),
  );

  it.effect("a stop that never answers times out and leaves the prompt asking the user", () =>
    provided(
      Effect.gen(function* () {
        const h = yield* noActivityPrompt({
          provider: { interruptTurn: () => Effect.never, stopSession: () => Effect.never },
        });
        const resolving = yield* Effect.forkChild(
          resolveRecovery(h.ctx, { threadId, messageId, action: "stop-and-continue" }),
        );
        yield* TestClock.adjust("25 seconds");
        yield* Fiber.join(resolving);
        assert.strictEqual(h.turnStarts().length, 0);
        assert.strictEqual(h.thread().recovery?.status, "awaiting-user");
        assert.isTrue(Option.isSome(yield* h.intents.get({ threadId, messageId })));
      }),
    ),
  );
});
