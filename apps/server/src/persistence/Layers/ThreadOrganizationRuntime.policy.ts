import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import { ReconcileOrganizationPolicy } from "../Services/ThreadOrganizationRuntime.ts";
import {
  latestAnchor,
  type OrganizationRuntimeQueries,
} from "./ThreadOrganizationRuntime.queries.ts";

export function makeReconcileOrganizationPolicy(
  sql: SqlClient.SqlClient,
  queries: OrganizationRuntimeQueries,
) {
  return Effect.fn("ThreadOrganizationRuntime.reconcilePolicy")(
    function* (request: ReconcileOrganizationPolicy) {
      const input = yield* Schema.decodeUnknownEffect(ReconcileOrganizationPolicy)(request);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* queries.lock();
          const current = yield* queries.policy();
          const same =
            current.policyFingerprint === input.policyFingerprint &&
            current.shortFingerprint === input.shortFingerprint &&
            current.olderFingerprint === input.olderFingerprint &&
            current.targetFingerprint === input.targetFingerprint;
          // A stale settings read cannot roll the persisted version back. Caller must
          // reread settings and this row before reconciling again (no blind CAS retry).
          if (current.policyVersion !== input.expectedPolicyVersion)
            return { status: "stale" as const, policy: current };
          if (same) return { status: "duplicate" as const, policy: current };
          if (input.initialize === true && current.policyVersion !== 0)
            return { status: "conflict" as const, policy: current };
          if (
            current.policyVersion === Number.MAX_SAFE_INTEGER ||
            !Number.isSafeInteger(input.nowMs + input.graceMs)
          )
            return { status: "conflict" as const, policy: current };
          const shortChanged = current.shortFingerprint !== input.shortFingerprint;
          const olderChanged = current.olderFingerprint !== input.olderFingerprint;
          const targetChanged = current.targetFingerprint !== input.targetFingerprint;
          yield* sql`UPDATE thread_organization_runtime SET
        policy_version = ${current.policyVersion + 1}, policy_fingerprint = ${input.policyFingerprint},
        short_fingerprint = ${input.shortFingerprint}, older_fingerprint = ${input.olderFingerprint},
        target_fingerprint = ${input.targetFingerprint},
        short_policy_changed_at_ms = ${shortChanged ? latestAnchor(current.shortPolicyChangedAtMs, input.nowMs) : current.shortPolicyChangedAtMs},
        older_policy_changed_at_ms = ${olderChanged && input.initialize !== true ? latestAnchor(current.olderPolicyChangedAtMs, input.nowMs) : current.olderPolicyChangedAtMs},
        target_drain_not_before_ms = ${targetChanged ? latestAnchor(current.targetDrainNotBeforeMs, input.nowMs + input.graceMs) : current.targetDrainNotBeforeMs}
        WHERE singleton = 1`;
          return { status: "applied" as const, policy: yield* queries.policy() };
        }),
      );
    },
    Effect.mapError(toPersistenceSqlError("ThreadOrganizationRuntime.reconcilePolicy")),
  );
}
