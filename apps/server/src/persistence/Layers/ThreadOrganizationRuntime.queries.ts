import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  OrganizationRuntimePolicy,
  OrganizationRuntimeThread,
} from "../Services/ThreadOrganizationRuntime.ts";

export function makeOrganizationRuntimeQueries(sql: SqlClient.SqlClient) {
  const policy = SqlSchema.findOne({
    Request: Schema.Void,
    Result: OrganizationRuntimePolicy,
    execute: () => sql`SELECT policy_version AS "policyVersion",
      policy_fingerprint AS "policyFingerprint", short_fingerprint AS "shortFingerprint",
      older_fingerprint AS "olderFingerprint", target_fingerprint AS "targetFingerprint",
      short_policy_changed_at_ms AS "shortPolicyChangedAtMs",
      older_policy_changed_at_ms AS "olderPolicyChangedAtMs",
      target_drain_not_before_ms AS "targetDrainNotBeforeMs",
      onboarding_decision AS "onboardingDecision", onboarding_version AS "onboardingVersion",
      canonical_frontier AS "canonicalFrontier"
      FROM thread_organization_runtime WHERE singleton = 1`,
  });
  const thread = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: OrganizationRuntimeThread,
    execute: (threadId) => sql`SELECT thread_id AS "threadId", fact_version AS "factVersion",
      source_frontier AS "sourceFrontier", transition_digest AS "transitionDigest",
      last_work_completed_at_ms AS "lastWorkCompletedAtMs",
      deliberate_organization_at_ms AS "deliberateOrganizationAtMs",
      manual_until_ms AS "manualUntilMs", attention_watermark AS "attentionWatermark",
      grace_until_ms AS "graceUntilMs", latest_automatic_move_id AS "latestAutomaticMoveId", deleted
      FROM thread_organization_runtime_threads WHERE thread_id = ${threadId}`,
  });
  return {
    policy: () => policy(undefined),
    thread: (threadId: string) => thread(threadId).pipe(Effect.map(Option.getOrUndefined)),
    // All mutation paths acquire this write lock FIRST. Nested command transactions
    // reuse the SQL client's transaction/savepoint; no opposing thread/global order.
    lock: () =>
      sql`UPDATE thread_organization_runtime SET singleton = singleton WHERE singleton = 1`,
  };
}
export type OrganizationRuntimeQueries = ReturnType<typeof makeOrganizationRuntimeQueries>;

export function latestAnchor(previous: number | null | undefined, observed: number): number {
  return Math.max(previous ?? 0, observed);
}
