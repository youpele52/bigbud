import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  countOutstandingRetentionItems,
  hasProviderRuntimePressure,
  retentionCircuitReopenAt,
  retentionRetryDelayMs,
  type ThreadRetentionRepositoryAuditExtensions,
} from "./ThreadRetention.coordinator.helpers.ts";

it.effect("uses the repository outstanding backlog count when available", () =>
  Effect.gen(function* () {
    let requestedRunId = "";
    const count = yield* countOutstandingRetentionItems(
      {
        countOutstandingItems: (runId: string) =>
          Effect.sync(() => {
            requestedRunId = runId;
            return 250;
          }),
      } as unknown as ThreadRetentionRepositoryAuditExtensions,
      "retention-run",
    );
    assert.equal(count, 250);
    assert.equal(requestedRunId, "retention-run");
  }),
);

it("opens the recent-failure circuit for 24 hours after the third failure", () => {
  assert.equal(
    retentionCircuitReopenAt({
      failureCount: 3,
      latestFailureAt: "2026-08-04T00:00:00.000Z",
      consecutiveFailureCount: 3,
    }),
    "2026-08-05T00:00:00.000Z",
  );
  assert.isNull(
    retentionCircuitReopenAt({
      failureCount: 2,
      latestFailureAt: "2026-08-04T00:00:00.000Z",
      consecutiveFailureCount: 2,
    }),
  );
});

it("caps exponential retention retries at 24 hours", () => {
  assert.equal(retentionRetryDelayMs(1), 15 * 60 * 1_000);
  assert.equal(retentionRetryDelayMs(20), 24 * 60 * 60 * 1_000);
});

it("treats provider startup and running states as pressure", () => {
  assert.isTrue(hasProviderRuntimePressure([{ status: "starting" }]));
  assert.isTrue(hasProviderRuntimePressure([{ status: "connecting" }]));
  assert.isTrue(hasProviderRuntimePressure([{ status: "running" }]));
  assert.isFalse(hasProviderRuntimePressure([{ status: "ready" }]));
});
