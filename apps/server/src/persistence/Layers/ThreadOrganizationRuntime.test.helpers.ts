import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export const policyInput = {
  expectedPolicyVersion: 0,
  policyFingerprint: "policy1",
  shortFingerprint: "short1",
  olderFingerprint: "older1",
  targetFingerprint: "disabled",
  nowMs: 1_000,
  graceMs: 300_000,
};
export const transitionInput = {
  threadId: "stable-thread",
  factVersion: 1,
  sourceFrontier: 10,
  source: "deliberate" as const,
  atMs: 500,
  attentionWatermark: 1,
  manualUntilMs: 600_500,
};

/** Writes a thread row exactly like the canonical hook: global row first, then the thread. */
export const writeRuntimeThread = (
  sql: SqlClient.SqlClient,
  input: { threadId: string; factVersion: number; sourceFrontier: number },
) =>
  Effect.gen(function* () {
    yield* sql`UPDATE thread_organization_runtime SET singleton = singleton WHERE singleton = 1`;
    yield* sql`INSERT INTO thread_organization_runtime_threads (thread_id, fact_version, source_frontier,
      transition_digest, attention_watermark, deleted)
      VALUES (${input.threadId}, ${input.factVersion}, ${input.sourceFrontier}, 'canonical-organization', 0, 0)
      ON CONFLICT (thread_id) DO UPDATE SET fact_version = excluded.fact_version,
        source_frontier = excluded.source_frontier`;
    yield* sql`UPDATE thread_organization_runtime SET canonical_frontier = MAX(canonical_frontier, ${input.sourceFrontier}) WHERE singleton = 1`;
  });
