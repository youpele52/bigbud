import { Effect, Layer } from "effect";

import { ServerConfig } from "./startup/config.ts";
import { ComputerUseLayerLive } from "./server.computerUse.ts";
import { VisibleBrowserControlLive } from "./browser/Layers/VisibleBrowserControl.ts";
import { OpenLive } from "./utils/open.ts";
import { AnalyticsServiceLayerLive } from "./telemetry/Layers/AnalyticsService.ts";
import { RemoteMobileControlFacadeLive } from "./remote-backend/mobileControlFacade.ts";
import { MobileRemoteControlLive } from "./mobile/Layers/MobileRemoteControl.ts";
import { DesktopSupervisorDeliveryLive } from "./desktop-supervisor/desktopSupervisorDelivery.layer.ts";
import {
  RemoteComputerUseLive,
  RemoteOpenLive,
  RemoteVisibleBrowserControlLive,
} from "./remote-backend/unavailable.host.ts";
import { RemoteAnalyticsLive, RemoteDeliveryLive } from "./remote-backend/unavailable.services.ts";

function profileLayer<A, E, R, E2, R2>(
  local: Layer.Layer<A, E, R>,
  remote: Layer.Layer<A, E2, R2>,
) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const selected: Layer.Layer<A, E | E2, R | R2> = config.mode === "remote" ? remote : local;
      return selected;
    }),
  );
}

// Stable layer values preserve memoization when the engine and routes share services.
export const ProfileComputerUseLive = profileLayer(ComputerUseLayerLive, RemoteComputerUseLive);
export const ProfileVisibleBrowserControlLive = profileLayer(
  VisibleBrowserControlLive,
  RemoteVisibleBrowserControlLive,
);
export const ProfileOpenLive = profileLayer(OpenLive, RemoteOpenLive);
export const ProfileAnalyticsLive = profileLayer(AnalyticsServiceLayerLive, RemoteAnalyticsLive);
export const ProfileMobileControlLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return config.mode === "remote" ? RemoteMobileControlFacadeLive : MobileRemoteControlLive;
  }),
);
export const ProfileDeliveryLive = profileLayer(DesktopSupervisorDeliveryLive, RemoteDeliveryLive);
