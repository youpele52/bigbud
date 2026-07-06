import type { ServerProvider } from "@bigbud/contracts";
import { Equal } from "effect";

function stripProviderSnapshotVolatileFields(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<Omit<ServerProvider, "checkedAt">> {
  return providers.map(({ checkedAt: _checkedAt, ...provider }) => provider);
}

export function areProviderSnapshotsEqual(
  previousProvider: ServerProvider,
  nextProvider: ServerProvider,
): boolean {
  return Equal.equals(
    stripProviderSnapshotVolatileFields([previousProvider]),
    stripProviderSnapshotVolatileFields([nextProvider]),
  );
}

export function haveProviderSnapshotsChanged(
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): boolean {
  return !Equal.equals(
    stripProviderSnapshotVolatileFields(previousProviders),
    stripProviderSnapshotVolatileFields(nextProviders),
  );
}
