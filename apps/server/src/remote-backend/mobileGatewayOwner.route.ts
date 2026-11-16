import * as ServiceMap from "effect/ServiceMap";
import type { RemoteBackendMobileDescriptor } from "@bigbud/contracts/server/remoteBackendHandshake";

export interface MobileGatewayRouteInput {
  readonly externalOrigin: string;
  readonly port: number;
  readonly expected: RemoteBackendMobileDescriptor;
}

/** Actual read-only Serve ownership and HTTPS identity, never a caller readiness flag. */
export interface VerifiedMobileGatewayRoute {
  /** Check original live lease and monotonic successful-verification age <=5 seconds.
   * No per-admission network/subprocess: one owned monitor rechecks route/TLS every
   * second, cycle <=5 seconds. Failure/clock regression/stale observation rejects. */
  readonly assertCurrent: (signal: AbortSignal) => Promise<void>;
}

export interface MobileGatewayRouteOwnerShape {
  /**
   * Invoke only after exact hostname:443 route/target and strict HTTPS identity verification.
   * Subscribe before final real reread. The callback signal aborts on observed route loss; settle owned
   * probes/watchers and the callback before returning. No mapping creation or mutation.
   */
  readonly withRoute: <A>(
    input: MobileGatewayRouteInput,
    operation: (route: VerifiedMobileGatewayRoute, signal: AbortSignal) => Promise<A>,
    signal: AbortSignal,
  ) => Promise<A>;
}

/** Optional at owner construction; absence keeps externally admitted status unavailable. */
export class RemoteMobileGatewayRouteOwner extends ServiceMap.Service<
  RemoteMobileGatewayRouteOwner,
  MobileGatewayRouteOwnerShape
>()("bigbud/remote-backend/MobileGatewayRouteOwner") {}
