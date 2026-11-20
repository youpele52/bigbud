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
import type { MobileGatewayProcessPort } from "./mobileGatewayOwner.port.ts";

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
  /** Same admission body as `run` (route verification, stamp equality, revocation) over another
   * opaque process port; `run` is exactly `runWith(proof, input, nodeMobileGatewayProcessPort)`. */
  readonly runWith: <R>(
    proof: VerifiedMobilePublication,
    input: MobileGatewayProcessInput,
    port: MobileGatewayProcessPort<R>,
  ) => Effect.Effect<
    void,
    Error,
    R | RemoteBackendIdentityService | ServerConfig | ServerSettingsService
  >;
}

/** Constructed before runtime; run later under the actual backend's scoped dependencies. */
export class RemoteMobileGatewayOwner extends ServiceMap.Service<
  RemoteMobileGatewayOwner,
  RemoteMobileGatewayOwnerShape
>()("bigbud/remote-backend/MobileGatewayOwner") {}
