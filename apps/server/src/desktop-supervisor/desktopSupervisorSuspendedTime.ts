/**
 * Forwards the supervisor's suspended-time clock (heartbeat `suspended_millis`, protocol 1.4)
 * to the server's sleep epochs. The clock exists only where the supervisor route runs, so it
 * is evidence, never a dependency: without `SystemSleepEpochs` the observer does nothing.
 *
 * @module desktopSupervisorSuspendedTime
 */
import { Effect, Option } from "effect";

import { SystemSleepEpochs } from "../system-sleep/Services/SystemSleepEpochs.ts";
import type { DesktopSupervisorHeartbeatEcho } from "./desktopSupervisorDelivery.heartbeat.ts";

export type SupervisorSuspendedTimeObserver = (echo: DesktopSupervisorHeartbeatEcho) => void;

export const makeSupervisorSuspendedTimeObserver: Effect.Effect<SupervisorSuspendedTimeObserver | null> =
  Effect.gen(function* () {
    const epochs = yield* Effect.serviceOption(SystemSleepEpochs);
    if (Option.isNone(epochs)) return null;
    return (echo) => {
      const suspendedMillis = echo.value.suspendedMillis;
      if (suspendedMillis === undefined) return;
      Effect.runFork(
        epochs.value.recordSupervisorSuspendedMillis({
          suspendedMillis,
          observedAtMs: Date.now(),
        }),
      );
    };
  });
