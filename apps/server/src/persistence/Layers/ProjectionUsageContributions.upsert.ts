import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { ProjectionUsageContribution } from "../Services/ProjectionThreadActivities.ts";

/** Canonical authority wins before sequence; corrections retain the original date. */
export function makeUpsertUsageContribution(sql: SqlClient.SqlClient) {
  return SqlSchema.void({
    Request: ProjectionUsageContribution,
    execute: (row) => sql`
      INSERT INTO projection_usage_contributions (
        contribution_id, accounting_json, activity_id, thread_id, turn_id, provider, model,
        interaction_mode, occurred_at, used_tokens, input_tokens, cached_input_tokens,
        output_tokens, reasoning_output_tokens, finalized, source_sequence, updated_at
      ) SELECT
        ${row.contributionId}, ${row.accounting ? JSON.stringify(row.accounting) : null},
        ${row.activityId}, ${row.threadId}, ${row.turnId}, ${row.provider}, ${row.model},
        ${row.interactionMode}, ${row.occurredAt}, ${row.usedTokens}, ${row.inputTokens},
        ${row.cachedInputTokens}, ${row.outputTokens}, ${row.reasoningOutputTokens},
        ${row.finalized ? 1 : 0}, ${row.sourceSequence}, ${row.updatedAt}
      WHERE NOT (${row.accounting?.source === "legacy" ? 1 : 0} = 1 AND EXISTS (
        SELECT 1 FROM projection_usage_contributions other WHERE other.thread_id = ${row.threadId}
          AND other.turn_id = ${row.turnId} AND other.contribution_id <> ${row.contributionId}
      ))
      ON CONFLICT (contribution_id) DO UPDATE SET
        activity_id = excluded.activity_id, accounting_json = excluded.accounting_json,
        thread_id = excluded.thread_id, turn_id = excluded.turn_id, provider = excluded.provider,
        model = excluded.model, interaction_mode = excluded.interaction_mode,
        used_tokens = excluded.used_tokens, input_tokens = excluded.input_tokens,
        cached_input_tokens = excluded.cached_input_tokens, output_tokens = excluded.output_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens, finalized = excluded.finalized,
        source_sequence = excluded.source_sequence, updated_at = excluded.updated_at
      WHERE (COALESCE(json_extract(excluded.accounting_json, '$.source') = 'provider-reported', 0)
        > COALESCE(json_extract(projection_usage_contributions.accounting_json, '$.source') = 'provider-reported', 0))
        OR ((COALESCE(json_extract(excluded.accounting_json, '$.source') = 'provider-reported', 0)
          = COALESCE(json_extract(projection_usage_contributions.accounting_json, '$.source') = 'provider-reported', 0))
          AND ((excluded.source_sequence IS NOT NULL AND (
            projection_usage_contributions.source_sequence IS NULL OR excluded.source_sequence >= projection_usage_contributions.source_sequence))
            OR (excluded.source_sequence IS NULL AND projection_usage_contributions.source_sequence IS NULL
              AND excluded.updated_at >= projection_usage_contributions.updated_at)))
    `,
  });
}
