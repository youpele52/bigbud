import * as Effect from "effect/Effect";
import type { RemoteMobileAdmissionStamp } from "./mobileGatewayStatus.ts";
import type { VerifiedMobilePublication } from "../remote-agent/mobileOptionalPublication.ts";
import { withMobilePublicationLifetime } from "../remote-agent/mobileGatewayLifecycle.publication.ts";
import type { VerifiedNativeLease } from "../remote-agent/remoteAgentServiceLeaseClient.ts";
import { RemoteAgentRuntimeOwners } from "../persistence/Layers/RemoteAgentRuntimeBindings.service.ts";
import type { BackendInstance } from "../startup/backendInstance.ts";
import type { ServerConfig } from "../startup/config.ts";
import type { RemoteBackendIdentityService } from "./identity.service.ts";
import type { MobileGatewayProcessInput } from "./mobileGatewayProcess.config.ts";
import { settledMobileGatewayProcess } from "./mobileGatewayProcess.lifetime.ts";
import {
  withMobileGatewayProcess,
  readVerifiedMobileGatewayProcess,
} from "./mobileGatewayProcess.ts";
import { nativeMobileActivationLease } from "./mobileGatewayActivation.native.ts";
import { mobileGatewayNativeAdmission } from "./mobileGatewayNative.admission.ts";

/** Fresh liveness/admission stamp of the one gateway process this port lifetime holds. */
export interface MobileGatewayLiveness {
  readonly read: (signal: AbortSignal) => Promise<RemoteMobileAdmissionStamp>;
}
type Run<R> = <A>(
  proof: VerifiedMobilePublication,
  selected: MobileGatewayProcessInput,
  use: (liveness: MobileGatewayLiveness, signal: AbortSignal) => Promise<A>,
) => Effect.Effect<A, Error, R>;
declare const portBrand: unique symbol;
/** Opaque process port. Only the constructors below mint one; structural objects are refused. */
export interface MobileGatewayProcessPort<R> {
  readonly [portBrand]: { readonly requirements: R };
}
const ports = new WeakMap<object, Run<unknown>>();
function mint<R>(run: Run<R>): MobileGatewayProcessPort<R> {
  const token = Object.freeze({}) as MobileGatewayProcessPort<R>;
  ports.set(token, run as unknown as Run<unknown>);
  return token;
}

/**
 * Resolve an original port before any owner lifetime begins, so a structural object is refused
 * without leaving repair state. The returned run holds the process and settles before returning.
 */
export function mobileGatewayProcessPortRun<R>(port: MobileGatewayProcessPort<R>): Run<R> {
  const run = ports.get(port) as Run<R> | undefined;
  if (!run) throw Error("Original mobile gateway process port required.");
  return run;
}

type NodeProcessRequirements =
  | BackendInstance
  | ServerConfig
  | RemoteBackendIdentityService
  | RemoteAgentRuntimeOwners;
/** Owned Node child: unchanged `withMobileGatewayProcess` + `readVerifiedMobileGatewayProcess`. */
export const nodeMobileGatewayProcessPort = mint<NodeProcessRequirements>((proof, selected, use) =>
  withMobileGatewayProcess(proof, selected, (token, signal) =>
    use({ read: (current) => readVerifiedMobileGatewayProcess(token, current) }, signal),
  ),
);

/** Idle native liveness interval; the route owner separately probes the gateway every second. */
export const NATIVE_GATEWAY_LIVENESS_INTERVAL_MS = 5_000;
/**
 * Native lease held by the activation worker's `use` phase. The worker, not this port, owns Start,
 * stop/detach and the durable exit; this lifetime ends with `signal` (worker detach/stop) or a
 * failed idle liveness read, and only closes its admission, so it never leaves owner repair behind. Default-off: no production caller.
 */
export function nativeMobileGatewayProcessPort(
  lease: VerifiedNativeLease,
  signal: AbortSignal,
): MobileGatewayProcessPort<RemoteAgentRuntimeOwners> {
  const { client, pending } = nativeMobileActivationLease(lease);
  return mint<RemoteAgentRuntimeOwners>((proof, selected, use) =>
    Effect.gen(function* () {
      const owners = yield* RemoteAgentRuntimeOwners;
      return yield* settledMobileGatewayProcess((external) =>
        withMobilePublicationLifetime(
          proof,
          async (lifetime) => {
            const scope = AbortSignal.any([signal, external, lifetime]);
            scope.throwIfAborted();
            const admission = await mobileGatewayNativeAdmission({
              proof,
              client,
              pending,
              lease,
              nonce: selected.nonce,
              port: selected.port,
              externalOrigin: selected.externalOrigin,
              owners,
              signal: scope,
            });
            // Bounded idle liveness: one batched admission read per interval, never queued, so a
            // dead or revoked native scope ends this lifetime without waiting for a mobile request.
            const watch = new AbortController();
            const lifetimeSignal = AbortSignal.any([scope, watch.signal]);
            let checking: Promise<void> | undefined,
              failure: { readonly cause: unknown } | undefined,
              closing = false;
            const timer = setInterval(() => {
              checking ??= admission
                .read(lifetimeSignal)
                .then(
                  () => {},
                  (cause: unknown) => {
                    if (closing || lifetimeSignal.aborted) return;
                    failure = { cause };
                    watch.abort(cause);
                  },
                )
                .finally(() => {
                  checking = undefined;
                });
            }, NATIVE_GATEWAY_LIVENESS_INTERVAL_MS);
            timer.unref();
            try {
              const value = await use({ read: admission.read }, lifetimeSignal);
              if (failure) throw failure.cause;
              return value;
            } finally {
              closing = true;
              clearInterval(timer);
              await admission.close();
              await checking;
            }
          },
          external,
        ),
      );
    }),
  );
}
