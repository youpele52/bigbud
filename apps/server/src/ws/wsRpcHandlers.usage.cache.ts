import { Cache, Effect, Exit } from "effect";
import type {
  ServerUsageError,
  ServerUsageRange,
  ServerUsageSummaryResult,
} from "@bigbud/contracts/server/usage.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

const caches = new WeakMap<ProjectionSnapshotQueryShape, ReturnType<typeof makeSummaryCache>>();

function makeSummaryCache(
  lookup: (range: ServerUsageRange) => Effect.Effect<ServerUsageSummaryResult, ServerUsageError>,
) {
  return Effect.runSync(
    Cache.makeWith({
      capacity: 4,
      lookup,
      // Short-lived, bounded summaries only: never retain the lifetime contribution rows.
      // Failures must be immediately retryable. Do not carry yesterday's streak past midnight.
      timeToLive: (exit) => {
        if (Exit.isFailure(exit)) return 0;
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setUTCHours(24, 0, 0, 0);
        return Math.min(5_000, tomorrow.getTime() - now.getTime());
      },
    }),
  );
}

/** Share in-flight reads and brief reopen results across RPC connections to the same database. */
export function cachedUsageSummary(
  query: ProjectionSnapshotQueryShape,
  lookup: (range: ServerUsageRange) => Effect.Effect<ServerUsageSummaryResult, ServerUsageError>,
) {
  let cache = caches.get(query);
  if (!cache) {
    cache = makeSummaryCache(lookup);
    caches.set(query, cache);
  }
  return (range: ServerUsageRange) => Cache.get(cache, range);
}
