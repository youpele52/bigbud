import * as Effect from "effect/Effect";
import { acquireMobileGatewayActivationAuthority } from "./mobileGatewayActivation.authority.ts";
import { repairMobileRuntimeAssets } from "./mobileGatewayAssets.orphan.ts";

/**
 * Orphan runtime-asset GC under the held activation authority: the locked backend state
 * directory, its claimed identity pin and the canonical CAS journal. Lease-free; it never touches
 * a native child, publication or pin.
 */
export const runMobileRuntimeAssetsRepair = Effect.fn("runMobileRuntimeAssetsRepair")(function* (
  signal: AbortSignal,
) {
  const authority = yield* acquireMobileGatewayActivationAuthority;
  return yield* Effect.tryPromise(() =>
    repairMobileRuntimeAssets(
      {
        stateDir: authority.owner.stateDir,
        pin: authority.pin,
        read: (current) => authority.registry(current).read(),
        assertAuthority: (current) => authority.assertAuthority(current),
      },
      signal,
    ),
  );
});

export type MobileRuntimeAssetsRepairServices = Effect.Services<
  ReturnType<typeof runMobileRuntimeAssetsRepair>
>;
