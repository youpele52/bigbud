/**
 * ProviderTurnSupervisorLive - wires the recovery coordinator to its inputs.
 *
 * Inputs: the 5 s tick; sleep epochs (`epoch-ended`, `network-online`); canonical provider
 * runtime events; orchestration domain events. Every intent mutation runs under one permit, so
 * the coordinator never races itself. Provider calls (inspection, stop) release the permit and
 * re-check the intent's revision afterwards. Without the recovery repository, only today's
 * health supervision runs.
 *
 * @module ProviderTurnSupervisorLive
 */
import { Cause, Effect, Layer, Option, Schedule, Semaphore, Stream } from "effect";

import { ProviderDispatchAttemptRepository } from "../../persistence/Services/ProviderDispatchAttempts.ts";
import { ThreadRecoveryIntentRepository } from "../../persistence/Services/ThreadRecoveryIntents.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerConfig } from "../../startup/config.ts";
import { SystemSleepEpochs } from "../../system-sleep/Services/SystemSleepEpochs.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderTurnSupervisor,
  type ProviderTurnSupervisorShape,
} from "../Services/ProviderTurnSupervisor.ts";
import { superviseProviderTurns } from "./ProviderTurnSupervisor.health.ts";
import {
  observeDomainEvent,
  observeRuntimeEvent,
  observeSleepEvent,
} from "./ProviderTurnSupervisor.observe.ts";
import { runRecoveryPass } from "./ProviderTurnSupervisor.recovery.ts";
import { handleBackendStart } from "./ProviderTurnSupervisor.startup.ts";
import {
  makeRecoveryMemory,
  readSleepContinuationEnabled,
  type RecoveryContext,
} from "./ProviderTurnSupervisor.state.ts";

export const PROVIDER_TURN_SUPERVISOR_INTERVAL = "5 seconds";
/** Settled and revoked intents are kept this long for diagnosis. */
const RESOLVED_INTENT_RETENTION_MS = 7 * 24 * 60 * 60_000;

const RECOVERY_DOMAIN_EVENT_TYPES = new Set([
  "thread.session-set",
  "thread.turn-start-failed",
  "thread.recovery-updated",
  "thread.turn-start-requested",
  "thread.prompt-queued",
  "thread.turn-interrupt-requested",
  "thread.session-stop-requested",
]);

const RECOVERY_RUNTIME_EVENT_TYPES = new Set([
  // Opens the coordinator's tracking of the turn and its tool items.
  "turn.started",
  "runtime.error",
  "turn.completed",
  "turn.aborted",
  "session.exited",
  "turn.plan.updated",
  "turn.proposed.delta",
  "turn.diff.updated",
  "item.started",
  "item.updated",
  "item.completed",
  "content.delta",
  "request.opened",
  "user-input.requested",
  "task.progress",
  "tool.progress",
  "tool.summary",
]);

export interface ProviderTurnSupervisorOptions {
  /** Clock for deterministic tests. */
  readonly nowMs?: () => number;
  /** Defaults to `BIGBUD_SLEEP_CONTINUATION` (on unless `0`). */
  readonly continuationEnabled?: boolean;
  /** Wall time this process started; defaults to the real process start. */
  readonly processStartedAtMs?: number;
}

const logFailure =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | void, never, R> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning(message, { cause: Cause.pretty(cause) }),
      ),
    );

export const makeProviderTurnSupervisor = Effect.fn("makeProviderTurnSupervisor")(function* (
  options: ProviderTurnSupervisorOptions = {},
) {
  const engine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const intents = yield* Effect.serviceOption(ThreadRecoveryIntentRepository);
  const attempts = yield* Effect.serviceOption(ProviderDispatchAttemptRepository);
  const sleep = yield* Effect.serviceOption(SystemSleepEpochs);
  const config = yield* Effect.serviceOption(ServerConfig);
  const permit = yield* Semaphore.make(1);
  // Callers hold the permit. Taking it back is uninterruptible, so the count stays balanced.
  const outsidePermit = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.acquireUseRelease(
      permit.release(1),
      () => effect,
      () => permit.take(1),
    );
  const nowMs = options.nowMs ?? (() => Date.now());
  const ctx: RecoveryContext | null = Option.isSome(intents)
    ? {
        engine,
        providerService,
        intents: intents.value,
        attempts,
        sleep,
        continuationEnabled: options.continuationEnabled ?? readSleepContinuationEnabled(),
        nowMs,
        memory: makeRecoveryMemory(),
        outsidePermit,
      }
    : null;
  const serialized = <A, E>(effect: Effect.Effect<A, E>) => permit.withPermits(1)(effect);
  const recovery = <E>(run: (context: RecoveryContext) => Effect.Effect<void, E>) =>
    ctx === null ? Effect.void : serialized(run(ctx)).pipe(logFailure("sleep recovery failed"));

  const runPass: ProviderTurnSupervisorShape["runPass"] = Effect.all(
    [
      superviseProviderTurns({
        orchestrationEngine: engine,
        providerService,
        now: () => new Date(nowMs()),
      }).pipe(logFailure("provider turn supervision failed")),
      recovery(runRecoveryPass),
    ],
    { discard: true },
  );

  const start: ProviderTurnSupervisorShape["start"] = Effect.fn("start")(function* () {
    if (ctx !== null) {
      const startReason = Option.getOrUndefined(config)?.desktopStartReason;
      yield* recovery((context) =>
        handleBackendStart(context, {
          startReason,
          processStartedAtMs: options.processStartedAtMs ?? Date.now() - process.uptime() * 1_000,
        }),
      );
      if (!ctx.continuationEnabled) {
        yield* Effect.logInfo("automatic sleep continuation is off (BIGBUD_SLEEP_CONTINUATION=0)");
      }
    }
    yield* runPass;
    yield* Effect.forkScoped(
      runPass.pipe(Effect.repeat(Schedule.fixed(PROVIDER_TURN_SUPERVISOR_INTERVAL))),
    );
    if (ctx === null) return;
    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) =>
        RECOVERY_RUNTIME_EVENT_TYPES.has(event.type)
          ? recovery((context) => observeRuntimeEvent(context, event))
          : Effect.void,
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        RECOVERY_DOMAIN_EVENT_TYPES.has(event.type)
          ? recovery((context) => observeDomainEvent(context, event))
          : Effect.void,
      ),
    );
    if (Option.isSome(sleep)) {
      yield* Effect.forkScoped(
        Stream.runForEach(sleep.value.events, (event) =>
          recovery((context) => observeSleepEvent(context, event)),
        ),
      );
    }
    yield* Effect.forkScoped(
      recovery((context) =>
        context.intents.pruneResolved({
          before: new Date(context.nowMs() - RESOLVED_INTENT_RETENTION_MS).toISOString(),
        }),
      ).pipe(Effect.repeat(Schedule.fixed("1 hour"))),
    );
  });

  return { start, runPass } satisfies ProviderTurnSupervisorShape;
});

export const ProviderTurnSupervisorLive = Layer.effect(
  ProviderTurnSupervisor,
  makeProviderTurnSupervisor(),
);
