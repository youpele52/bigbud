import { Effect, Layer } from "effect";

import { resolveDesktopSupervisorRuntimeConfig } from "./desktopSupervisorConfig.ts";
import {
  DesktopSupervisorDelivery,
  DesktopSupervisorDeliveryCoordinator,
} from "./desktopSupervisorDelivery.ts";
import { makeSupervisorSuspendedTimeObserver } from "./desktopSupervisorSuspendedTime.ts";

export const DesktopSupervisorDeliveryLive = Layer.effect(
  DesktopSupervisorDelivery,
  Effect.gen(function* () {
    const observer = yield* makeSupervisorSuspendedTimeObserver;
    return yield* Effect.acquireRelease(
      Effect.sync(() => {
        const coordinator = new DesktopSupervisorDeliveryCoordinator(
          resolveDesktopSupervisorRuntimeConfig(),
        );
        coordinator.heartbeatEchoObserver = observer;
        return coordinator;
      }),
      (coordinator) => Effect.promise(() => coordinator.close()),
    );
  }),
);
