import * as ServiceMap from "effect/ServiceMap";
import type * as Effect from "effect/Effect";
import type { BackendInstance } from "../startup/backendInstance.ts";
import type { RemoteBackendIdentityService } from "./identity.service.ts";
import type { ServerConfig } from "../startup/config.ts";
import type { ServerSettingsService } from "../ws/serverSettings.ts";
import type { RemoteAgentRuntimeOwners } from "../persistence/Layers/RemoteAgentRuntimeBindings.service.ts";
import type { VerifiedMobilePublication } from "../remote-agent/mobileOptionalPublication.ts";
import type { MobileGatewayProcessInput } from "./mobileGatewayProcess.config.ts";
import type { MobileGatewayOwnerPhase } from "./mobileGatewayOwner.state.ts";

export interface RemoteMobileGatewayOwnerShape {
  readonly getPhase: () => MobileGatewayOwnerPhase;
  readonly run: (
    proof: VerifiedMobilePublication,
    input: MobileGatewayProcessInput,
  ) => Effect.Effect<
    void,
    Error,
    | BackendInstance
    | RemoteBackendIdentityService
    | ServerConfig
    | ServerSettingsService
    | RemoteAgentRuntimeOwners
  >;
}

/** Constructed before runtime; run later under the actual backend's scoped dependencies. */
export class RemoteMobileGatewayOwner extends ServiceMap.Service<
  RemoteMobileGatewayOwner,
  RemoteMobileGatewayOwnerShape
>()("bigbud/remote-backend/MobileGatewayOwner") {}
