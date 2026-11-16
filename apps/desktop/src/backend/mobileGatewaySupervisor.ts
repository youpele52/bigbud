import { MobileGatewaySupervisor as SharedSupervisor } from "@bigbud/shared/mobileGatewaySupervisor";
import type {
  MobileGatewayLaunch as SharedLaunch,
  MobileGatewayDependencies,
  MobileGatewayStatus as SharedStatus,
} from "@bigbud/shared/mobileGatewaySupervisor.config";

export interface MobileGatewayLaunch extends Omit<SharedLaunch, "upstream"> {
  readonly backendPort: number;
}
export type MobileGatewayStatus = SharedStatus;

/** Preserve the desktop loopback API while sharing the owned transport lifecycle. */
export class MobileGatewaySupervisor extends SharedSupervisor {
  constructor(config: MobileGatewayLaunch, deps: MobileGatewayDependencies = {}) {
    const { backendPort, ...launch } = config;
    super({ ...launch, upstream: { kind: "loopback", port: backendPort } }, deps);
  }
}
