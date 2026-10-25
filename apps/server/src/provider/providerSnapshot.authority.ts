import type { ServerProvider } from "@bigbud/contracts";
import { buildServerProvider } from "./providerSnapshot.ts";
import {
  guardProviderPublication,
  inheritProviderPublication,
  validProviderPublication,
} from "./providerPublication.ts";

const invalidations = new WeakMap<ServerProvider, () => ServerProvider>();

/** An invalid cache is a warning with no native inventory/auth/readiness, never a fresh probe. */
export function invalidatedProviderSnapshot(snapshot: ServerProvider): ServerProvider {
  return {
    ...buildServerProvider({
      provider: snapshot.provider,
      enabled: snapshot.enabled,
      checkedAt: snapshot.checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Provider status was invalidated. Refresh to verify current availability.",
      },
    }),
    initialProbeComplete: false,
  };
}

export function guardProviderSnapshot(
  snapshot: ServerProvider,
  validate: (() => void) | undefined,
  invalidate: () => ServerProvider,
): void {
  guardProviderPublication(snapshot, validate);
  if (validate) invalidations.set(snapshot, invalidate);
}

/** Resolve again at cache reads, copied registry enqueue, and each buffered consumer delivery. */
export function currentProviderSnapshot(snapshot: ServerProvider): ServerProvider {
  return validProviderPublication(snapshot)
    ? snapshot
    : (invalidations.get(snapshot)?.() ?? invalidatedProviderSnapshot(snapshot));
}

/** Decoration must carry both the original validator and safe invalidation policy. */
export function inheritProviderSnapshot(
  source: ServerProvider,
  target: ServerProvider,
): ServerProvider {
  inheritProviderPublication(source, target);
  const invalidate = invalidations.get(source);
  if (invalidate) invalidations.set(target, invalidate);
  return target;
}

export function currentProviderSnapshots(
  snapshots: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  return snapshots.map(currentProviderSnapshot);
}
