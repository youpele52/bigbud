import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { buildOrganizationFacts, type OrganizationOwnerFacts } from "./organizationFacts.build.ts";
import { orchestrationSequenceFrontierSql } from "../persistence/OrchestrationSequenceFrontier.ts";
import { readOrganizationRawFacts } from "./organizationFacts.query.ts";

/** TS observation/DB boundary only. No rule, candidate selection or independent timer.
 * Sources are sampled outside the transaction; changed raw facts force retry instead of
 * publishing a stale async read over a newer manual/request transition. The returned frontier
 * is read inside the same write transaction (>= canonical_frontier), so a canonical command
 * committed concurrently can never make a later fact appear behind the published frontier.
 */
export function makeOrganizationFactStore<E>(input: {
  sql: SqlClient.SqlClient;
  owners: (threadId: string) => Effect.Effect<OrganizationOwnerFacts, E>;
  now: () => number;
}) {
  const { sql } = input;
  const observe = Effect.fn("OrganizationFacts.observe")(
    function* (threadId: string, graceMs: number) {
      if (!Number.isInteger(graceMs) || graceMs < 120000 || graceMs > 600000)
        return yield* Effect.fail(new Error("invalid organisation grace"));
      const [raw] = yield* readOrganizationRawFacts(sql, threadId);
      if (!raw) {
        // A missing row still reports the authoritative frontier so a tombstone is never
        // published behind the canonical deletion that removed the projection row.
        const [current] = yield* sql<{
          frontier: number;
        }>`SELECT MAX(${orchestrationSequenceFrontierSql(sql)}, COALESCE((SELECT canonical_frontier
            FROM thread_organization_runtime WHERE singleton = 1), 0)) AS frontier`;
        return { status: "missing" as const, frontier: current?.frontier ?? 0, row: undefined };
      }
      const owners = yield* input.owners(threadId);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE thread_organization_runtime SET singleton = singleton WHERE singleton = 1`;
          const [latest] = yield* readOrganizationRawFacts(sql, threadId);
          const [global] = yield* sql<{
            canonical_frontier: number;
          }>`SELECT canonical_frontier FROM thread_organization_runtime WHERE singleton = 1`;
          const [source] = yield* sql<{
            frontier: number;
          }>`SELECT ${orchestrationSequenceFrontierSql(sql)} AS frontier`;
          if (!latest || JSON.stringify(latest) !== JSON.stringify(raw) || !global || !source)
            return { status: "stale" as const };
          const frontier = Math.max(source.frontier, global.canonical_frontier);
          const built = yield* Effect.try({
            try: () => buildOrganizationFacts(latest, owners, input.now(), graceMs),
            catch: toPersistenceSqlError("OrganizationFacts.build"),
          });
          if (latest.semanticDigest === built.digest && latest.factVersion !== null)
            return { status: "unchanged" as const, frontier, row: built.row };
          const version = (latest.factVersion ?? 0) + 1;
          if (!Number.isSafeInteger(version))
            return yield* Effect.fail(new Error("organisation fact version exhausted"));
          yield* sql`INSERT INTO thread_organization_runtime_threads
        (thread_id, fact_version, source_frontier, transition_digest, last_work_completed_at_ms,
          deliberate_organization_at_ms, manual_until_ms, attention_watermark, grace_until_ms,
          latest_automatic_move_id, deleted, semantic_digest, last_work_state, manual_attention_watermark, attention_ids_json)
        VALUES (${threadId}, ${version}, ${frontier}, ${built.digest}, ${built.completionAt || null}, NULL,
          ${latest.manualUntilMs}, ${built.row.attentionWatermark}, ${built.graceUntil || null}, NULL,
          ${latest.deleted ?? 0}, ${built.digest}, ${built.workState}, ${latest.manualAttentionWatermark ?? 0}, ${JSON.stringify(built.attentionIds)})
        ON CONFLICT (thread_id) DO UPDATE SET fact_version = excluded.fact_version,
          source_frontier = excluded.source_frontier, transition_digest = excluded.transition_digest,
          last_work_completed_at_ms = excluded.last_work_completed_at_ms,
          attention_watermark = excluded.attention_watermark, grace_until_ms = excluded.grace_until_ms,
          semantic_digest = excluded.semantic_digest, last_work_state = excluded.last_work_state,
          attention_ids_json = excluded.attention_ids_json`;
          yield* sql`UPDATE thread_organization_runtime SET canonical_frontier = MAX(canonical_frontier, ${frontier}) WHERE singleton = 1`;
          return {
            status: "applied" as const,
            frontier,
            row: { ...built.row, factVersion: version },
          };
        }),
      );
    },
    Effect.mapError(toPersistenceSqlError("OrganizationFacts.observe")),
  );
  return { observe };
}
