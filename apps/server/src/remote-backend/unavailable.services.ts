import { Effect, Layer } from "effect";

import { MobileRemoteControl } from "../mobile/Services/MobileRemoteControl.ts";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService.ts";
import {
  DesktopSupervisorDelivery,
  DesktopSupervisorDeliveryCoordinator,
} from "../desktop-supervisor/desktopSupervisorDelivery.ts";

export const RemoteMobileControlLive = Layer.succeed(MobileRemoteControl, {
  createPairing: () =>
    Effect.fail(new Error("Mobile pairing is unavailable in this remote profile.")),
  getPairingStatus: () => Effect.succeed(null),
  exchangePairing: () =>
    Effect.fail(new Error("Mobile pairing is unavailable in this remote profile.")),
  listSessions: Effect.succeed([]),
  revokeSession: () =>
    Effect.fail(new Error("Mobile pairing is unavailable in this remote profile.")),
  validateSessionToken: () => Effect.succeed(null),
});

// A remote authority never implicitly opts its owner into anonymous telemetry.
export const RemoteAnalyticsLive = Layer.succeed(AnalyticsService, {
  record: () => Effect.void,
  flush: Effect.void,
});

// Preserve real TypeScript delivery receipts without installing desktop-native observers.
export const RemoteDeliveryLive = Layer.effect(
  DesktopSupervisorDelivery,
  Effect.acquireRelease(
    Effect.sync(
      () =>
        new DesktopSupervisorDeliveryCoordinator({
          mode: "direct-unmanaged",
          reasonCode: "standalone",
        }),
    ),
    (coordinator) => Effect.promise(() => coordinator.close()),
  ),
);
