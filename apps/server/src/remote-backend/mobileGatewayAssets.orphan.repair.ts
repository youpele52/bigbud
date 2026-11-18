import * as Effect from "effect/Effect";
import { withMobileOptionalPublisher } from "../remote-agent/mobileOptionalPublication.ts";
import { acquireMobileGatewayActivationAuthority } from "./mobileGatewayActivation.authority.ts";
import { repairMobileRuntimeAssets } from "./mobileGatewayAssets.orphan.ts";

/**
 * Orphan runtime-asset GC under the held activation authority: the locked backend state
 * directory, its claimed identity pin and the canonical CAS journal. Lease-free; it never touches
 * a native child or pin. Then stage retirement, which needs the publication lease: while an
 * activation holds it, retirement is skipped (`stages: null`) and runs at its next publication.
 */
export const runMobileRuntimeAssetsRepair = Effect.fn("runMobileRuntimeAssetsRepair")(function* (
  signal: AbortSignal,
) {
  const authority = yield* acquireMobileGatewayActivationAuthority;
  const report = yield* Effect.tryPromise(() =>
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
  // Retirement reads no release keys: it only removes files the journal already recorded.
  const stages = yield* withMobileOptionalPublisher({}, (publisher, lifetime) =>
    publisher.retire(AbortSignal.any([signal, lifetime])),
  ).pipe(Effect.orElseSucceed(() => null));
  return { ...report, stages };
});

export type MobileRuntimeAssetsRepairServices = Effect.Services<
  ReturnType<typeof runMobileRuntimeAssetsRepair>
>;
