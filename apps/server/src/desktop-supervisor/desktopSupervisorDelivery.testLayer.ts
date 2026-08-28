import { Layer } from "effect";

import {
  DesktopSupervisorDelivery,
  DesktopSupervisorDeliveryCoordinator,
} from "./desktopSupervisorDelivery.ts";

export const DesktopSupervisorDeliveryTestLive = Layer.succeed(
  DesktopSupervisorDelivery,
  new DesktopSupervisorDeliveryCoordinator({
    mode: "direct-unmanaged",
    reasonCode: "standalone",
  }),
);
