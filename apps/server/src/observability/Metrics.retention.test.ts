import { assert, it } from "@effect/vitest";

import {
  threadRetentionDeferralMetricAttributes,
  threadRetentionEligibilityMetricAttributes,
  threadRetentionItemMetricAttributes,
} from "./Metrics.ts";

it("keeps retention deferral metric labels low-cardinality", () => {
  assert.deepEqual(threadRetentionDeferralMetricAttributes("provider_pressure"), {
    reason: "provider_pressure",
  });
  assert.deepEqual(threadRetentionDeferralMetricAttributes("thread-id:/secret/path"), {
    reason: "unknown",
  });
});

it("keeps retention item skip reasons low-cardinality", () => {
  assert.deepEqual(threadRetentionItemMetricAttributes("skipped", "running"), {
    outcome: "skipped",
    reason: "running",
  });
  assert.deepEqual(threadRetentionItemMetricAttributes("skipped", "thread-id:/secret/path"), {
    outcome: "skipped",
    reason: "unknown",
  });
  assert.deepEqual(threadRetentionItemMetricAttributes("completed", "running"), {
    outcome: "completed",
  });
});

it("keeps retention eligibility metric labels low-cardinality", () => {
  assert.deepEqual(threadRetentionEligibilityMetricAttributes("pinned"), {
    outcome: "excluded",
    reason: "pinned",
  });
  assert.deepEqual(threadRetentionEligibilityMetricAttributes("thread-id:/secret/path"), {
    outcome: "excluded",
    reason: "unknown",
  });
});
