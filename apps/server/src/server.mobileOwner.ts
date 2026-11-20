import * as Layer from "effect/Layer";
import { RemoteMobileGatewayOwnerLive } from "./remote-backend/mobileGatewayOwner.ts";
import { RemoteMobileGatewayRouteOwnerLive } from "./remote-backend/mobileGatewayRouteOwner.ts";
import { RemoteMobileGatewayActivationLive } from "./remote-backend/mobileGatewayActivation.service.ts";

/** Allocate the real idle owner before runtime consumers capture their admission services.
 * Neither constructor performs IO or starts access. The original publication/process lifecycle
 * and verified tailnet route are still required by the owner's later scoped run operation. */
export const RemoteMobileGatewayCompositionLive = Layer.merge(
  RemoteMobileGatewayOwnerLive.pipe(Layer.provide(RemoteMobileGatewayRouteOwnerLive)),
  RemoteMobileGatewayActivationLive,
);
