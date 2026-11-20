import * as Effect from "effect/Effect";
import { RemoteAgentRuntimeOwners } from "../persistence/Layers/RemoteAgentRuntimeBindings.service.ts";
import { acquireMobileGatewayActivationAuthority } from "./mobileGatewayActivation.authority.ts";
import {
  readNativeMobileHostEvidence,
  resolveEndedNativeMobileAttempts,
} from "./mobileGatewayNative.resolve.ts";

/**
 * Owner-requested settlement of attempted native rows under the held activation authority: the
 * locked backend, its claimed identity pin and the canonical CAS journal. It reads the kernel boot
 * id and the canonical agent epoch, never signals or adopts a native process.
 */
export const runMobileNativeResolve = Effect.fn("runMobileNativeResolve")(function* (
  signal: AbortSignal,
) {
  const authority = yield* acquireMobileGatewayActivationAuthority;
  const owners = yield* RemoteAgentRuntimeOwners;
  return yield* Effect.tryPromise(async () => {
    const host = await readNativeMobileHostEvidence(owners, authority.pin);
    return resolveEndedNativeMobileAttempts(
      {
        pin: authority.pin,
        registry: (current) => authority.registry(AbortSignal.any([current, signal])),
      },
      host,
      signal,
    );
  });
});

export type MobileNativeResolveServices = Effect.Services<
  ReturnType<typeof runMobileNativeResolve>
>;
