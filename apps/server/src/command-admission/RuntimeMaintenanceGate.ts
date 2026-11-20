/**
 * Runtime maintenance gate (M3 WP-4D). Closes public command admission while a remote runtime
 * update drains, backs up and activates, and keeps it closed in a freshly restarted runtime until
 * its trial readiness settles. Only remote backends compose it; every consumer reads it with
 * `Effect.serviceOption`, so local backends and tests behave exactly as before.
 *
 * The gate never interrupts anything itself. It counts public commands admitted since this
 * process started (`admitted`): an activation may roll back automatically only while that is 0.
 */
import { Effect, Option, ServiceMap } from "effect";

import type { ServerRuntimeStartupShape } from "../startup/serverRuntimeStartup.ts";

import { COMMAND_ADMISSION_RETRY_AFTER_MS, CommandAdmissionError } from "./CommandAdmission.ts";

export interface RuntimeMaintenanceGateShape {
  readonly isClosed: () => boolean;
  readonly close: Effect.Effect<void>;
  /** Reopens admission and runs the reopen hooks (held queued-prompt flushes). */
  readonly open: Effect.Effect<void>;
  /** Public commands admitted since this process started. */
  readonly admitted: () => number;
  /** Public commands currently running through the gate. */
  readonly inFlight: () => number;
  /** Fails with an `overloaded` admission error (retry with the same command id) while closed. */
  readonly guard: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | CommandAdmissionError, R>;
  /** Held work to release when admission reopens without a restart. */
  readonly onReopen: (hook: Effect.Effect<void>) => void;
}

export class RuntimeMaintenanceGate extends ServiceMap.Service<
  RuntimeMaintenanceGate,
  RuntimeMaintenanceGateShape
>()("bigbud/command-admission/RuntimeMaintenanceGate") {}

export const RUNTIME_MAINTENANCE_RETRY_AFTER_MS = COMMAND_ADMISSION_RETRY_AFTER_MS * 20;

export function makeRuntimeMaintenanceGate(input: {
  readonly initiallyClosed: boolean;
}): RuntimeMaintenanceGateShape {
  let closed = input.initiallyClosed;
  let admitted = 0;
  let inFlight = 0;
  const hooks: Array<Effect.Effect<void>> = [];
  const refused = () =>
    new CommandAdmissionError({
      code: "overloaded",
      queue: "orchestration",
      message: "The backend is updating its runtime; retry with the same command ID.",
      retryAfterMs: RUNTIME_MAINTENANCE_RETRY_AFTER_MS,
    });
  return {
    isClosed: () => closed,
    close: Effect.sync(() => {
      closed = true;
    }),
    open: Effect.suspend(() => {
      if (!closed) return Effect.void;
      closed = false;
      return Effect.forEach(hooks, (hook) => hook.pipe(Effect.ignoreCause({ log: true })), {
        discard: true,
      });
    }),
    admitted: () => admitted,
    inFlight: () => inFlight,
    guard: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.suspend((): Effect.Effect<A, E | CommandAdmissionError, R> => {
        if (closed) return Effect.fail(refused());
        admitted += 1;
        inFlight += 1;
        return effect.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              inFlight -= 1;
            }),
          ),
        );
      }),
    onReopen: (hook) => {
      hooks.push(hook);
    },
  };
}

/** Public command admission through the gate; unchanged when no gate is composed. */
export function gateServerRuntimeStartup(
  startup: ServerRuntimeStartupShape,
  gate: Option.Option<RuntimeMaintenanceGateShape>,
): ServerRuntimeStartupShape {
  if (Option.isNone(gate)) return startup;
  return {
    ...startup,
    enqueueCommand: (effect) => gate.value.guard(startup.enqueueCommand(effect)),
  };
}
