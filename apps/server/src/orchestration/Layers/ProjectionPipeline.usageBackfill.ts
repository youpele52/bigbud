import { Effect } from "effect";

import type { ProjectionThreadActivityRepositoryShape } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { usageContributionFromBackfillRow } from "./ProjectionPipeline.projector.threadActivities.usage.ts";

const USAGE_BACKFILL_BATCH_SIZE = 100;

export function runUsageContributionBackfill(input: {
  readonly repository: ProjectionThreadActivityRepositoryShape;
}) {
  return Effect.gen(function* () {
    let state = yield* input.repository.getUsageBackfillState();
    if (state.completed) {
      return;
    }

    while (!state.completed) {
      const rows = yield* input.repository.listUsageBackfillBatch({
        afterActivityId: state.lastActivityId,
        limit: USAGE_BACKFILL_BATCH_SIZE,
      });
      const now = new Date().toISOString();
      const lastActivityId = rows.at(-1)?.activityId ?? state.lastActivityId;
      const completed = rows.length === 0;

      yield* Effect.forEach(
        rows,
        (row) => {
          const contribution = usageContributionFromBackfillRow(row);
          return contribution
            ? input.repository.upsertUsageContribution(contribution)
            : Effect.void;
        },
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
      yield* input.repository.advanceUsageBackfillState({
        lastActivityId,
        completed,
        updatedAt: now,
      });

      state = { lastActivityId, completed, updatedAt: now };
      yield* Effect.yieldNow;
    }

    yield* Effect.logInfo("usage contribution backfill completed", {
      lastActivityId: state.lastActivityId,
    });
  });
}
