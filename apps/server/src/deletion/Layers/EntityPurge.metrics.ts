import { Effect } from "effect";

import {
  increment,
  threadRetentionRemovedKnownBytes,
  threadRetentionRemovedResources,
} from "../../observability/Metrics.ts";
import type { PurgeResource } from "../../persistence/Services/PurgeJobRepository.ts";

export const recordRemovedPurgeResource = Effect.fn("EntityPurge.recordRemovedResource")(function* (
  resourceKind: PurgeResource["kind"],
  removed: { readonly removed: boolean; readonly knownBytes: number },
) {
  if (!removed.removed) return;
  const attributes = { resourceKind };
  yield* increment(threadRetentionRemovedResources, attributes);
  yield* increment(threadRetentionRemovedKnownBytes, attributes, removed.knownBytes);
});
