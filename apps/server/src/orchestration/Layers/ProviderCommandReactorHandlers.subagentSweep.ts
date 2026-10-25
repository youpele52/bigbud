/**
 * Runs after a thread Stop (turn interrupt) the provider acknowledged, or an idle Stop. Stopping the thread stops all of its
 * subagents, background ones included:
 *
 * 1. The provider is asked to stop every running subagent the interrupt may not end (background
 *    children outlive the turn): `ProviderService.stopThreadSubagents` uses the adapter's own
 *    cascade (Pi) or per-subagent Stop (Claude); the interrupt already ends the rest.
 * 2. After a grace period for provider-reported outcomes, and once the stopped turn has
 *    settled, rows still shown as running are marked stopped (every provider).
 *
 * Runs forked so the thread's intent worker is never blocked by the grace period.
 *
 * @module ProviderCommandReactorHandlers.subagentSweep
 */
import type { OrchestrationEvent, OrchestrationThread, ThreadId, TurnId } from "@bigbud/contracts";
import { Cause, Clock, Duration, Effect } from "effect";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import {
  buildStoppedSubagentSnapshot,
  selectRunningSubagents,
  stillRunningTargets,
} from "../SubagentStopSweep.logic.ts";
import { serverCommandId } from "./ProviderCommandReactorHelpers.ts";

/** Time the provider gets to report its own outcome before bigbud settles the rows. */
export const SUBAGENT_SWEEP_GRACE = Duration.seconds(3);
/** Grace periods to wait for the stopped turn to settle before leaving rows as reported. */
export const SUBAGENT_SWEEP_MAX_CHECKS = 5;

export function makeSweepSubagentsAfterInterrupt(deps: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly providerService: typeof ProviderService.Service;
  readonly resolveThread: (threadId: ThreadId) => Effect.Effect<OrchestrationThread | undefined>;
}) {
  return Effect.fn("sweepSubagentsAfterInterrupt")(function* (input: {
    readonly threadId: ThreadId;
    /** The turn the Stop targeted; `null` when no active turn was known. */
    readonly interruptedTurnId: TurnId | null;
    readonly requestedAt: string;
  }) {
    const thread = yield* deps.resolveThread(input.threadId);
    if (!thread) return;
    const targets = selectRunningSubagents(thread.tasks ?? [], input.requestedAt);
    if (targets.length === 0) return;
    // Background children can outlive the interrupt; each provider stops what its protocol allows.
    yield* (
      deps.providerService.stopThreadSubagents?.({
        threadId: input.threadId,
        subagents: targets.flatMap((task) =>
          task.nativeId ? [{ nativeId: task.nativeId, background: task.background === true }] : [],
        ),
      }) ?? Effect.void
    ).pipe(Effect.catchCause(() => Effect.void));
    const targetIds = new Set(targets.map((task) => task.id));

    for (let check = 0; check < SUBAGENT_SWEEP_MAX_CHECKS; check += 1) {
      yield* Effect.sleep(SUBAGENT_SWEEP_GRACE);
      const current = yield* deps.resolveThread(input.threadId);
      if (!current) return;
      // The interrupt has not taken effect yet; the subagents may still be running.
      if (
        input.interruptedTurnId !== null &&
        current.session?.activeTurnId === input.interruptedTurnId
      )
        continue;
      const stoppedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      for (const task of stillRunningTargets(current.tasks ?? [], targetIds)) {
        yield* deps.orchestrationEngine.dispatch({
          type: "thread.task.upsert",
          commandId: serverCommandId("subagent-stop-sweep"),
          threadId: input.threadId,
          task: buildStoppedSubagentSnapshot(task, stoppedAt),
          createdAt: stoppedAt,
        });
      }
      return;
    }
    yield* Effect.logWarning("stopped turn did not settle; subagent rows left as reported", {
      threadId: input.threadId,
      interruptedTurnId: input.interruptedTurnId,
      subagentCount: targets.length,
    });
  });
}

/** Runs the turn interrupt, then forks the subagent sweep when it took effect or was idle. */
export function withSubagentSweepAfterInterrupt<E>(deps: {
  readonly resolveThread: (threadId: ThreadId) => Effect.Effect<OrchestrationThread | undefined>;
  readonly sweep: ReturnType<typeof makeSweepSubagentsAfterInterrupt>;
  readonly processTurnInterruptRequested: (
    event: Extract<OrchestrationEvent, { type: "thread.turn-interrupt-requested" }>,
  ) => Effect.Effect<boolean, E>;
}) {
  return Effect.fn("processTurnInterruptWithSubagentSweep")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const before = yield* deps.resolveThread(event.payload.threadId);
    const acknowledged = yield* deps.processTurnInterruptRequested(event);
    if (!before) return;
    // An idle Stop targets the background subagents themselves, so it settles them even when
    // the provider had no turn to interrupt or no live session (its children are then gone).
    const idleStop = before.session?.activeTurnId == null && event.payload.operation === undefined;
    if (!acknowledged && !idleStop) return;
    yield* deps
      .sweep({
        threadId: event.payload.threadId,
        interruptedTurnId: event.payload.turnId ?? before.session?.activeTurnId ?? null,
        requestedAt: event.payload.createdAt,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("subagent stop sweep failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.forkScoped,
      );
  });
}
