import { Layer } from "effect";

import {
  DesktopSupervisorDelivery,
  DesktopSupervisorDeliveryCoordinator,
} from "./desktopSupervisorDelivery.ts";

/** The coordinator behind `DesktopSupervisorDeliveryTestLive`, for presence assertions. */
export const desktopSupervisorDeliveryTestCoordinator = new DesktopSupervisorDeliveryCoordinator({
  mode: "direct-unmanaged",
  reasonCode: "standalone",
});

export const DesktopSupervisorDeliveryTestLive = Layer.succeed(
  DesktopSupervisorDelivery,
  desktopSupervisorDeliveryTestCoordinator,
);
