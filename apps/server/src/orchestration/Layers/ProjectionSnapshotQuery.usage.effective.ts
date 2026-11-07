/** Attribution comes only from projections: `projection_turns` carries each turn's provider, model
 * and mode (migration 157 backfilled turns that predate them), so compaction of old
 * `orchestration_events` never changes usage. Never infer from current thread settings.
 * Shared effective population suppresses overlaps before date filtering or streak calculation.
 */
function makeEffectiveUsageCte() {
  return `WITH attributed_turns AS (
  SELECT t.*,
    COALESCE(t.usage_provider, 'unknown') AS effective_provider,
    COALESCE(t.usage_model, 'unknown') AS effective_model,
    COALESCE(t.usage_interaction_mode, 'unknown') AS effective_mode
  FROM projection_turns t
), official AS (
  SELECT c.* FROM projection_usage_contributions c
  WHERE (COALESCE(json_extract(c.accounting_json, '$.source'), 'legacy') = 'legacy' OR c.turn_id IS NOT NULL) AND NOT EXISTS (
    SELECT 1 FROM projection_usage_contributions authority
    WHERE authority.thread_id = c.thread_id AND authority.turn_id = c.turn_id
      AND json_extract(authority.accounting_json, '$.source') = 'provider-reported'
      AND authority.contribution_id <> c.contribution_id
      AND ((COALESCE(json_extract(c.accounting_json, '$.source'), 'legacy') = 'legacy'
        AND c.contribution_id = c.provider || ':' || c.thread_id || ':turn:' || c.turn_id) OR (
        authority.finalized = 1 AND authority.contribution_id =
          authority.provider || ':' || authority.thread_id || ':turn:' || authority.turn_id
        AND c.contribution_id <> c.provider || ':' || c.thread_id || ':turn:' || c.turn_id
      ))
  )
), observable_turns AS MATERIALIZED (
  SELECT t.* FROM attributed_turns t
  WHERE t.turn_id IS NOT NULL AND t.started_at IS NOT NULL
    AND t.state IN ('completed', 'error', 'interrupted')
    AND NOT EXISTS (SELECT 1 FROM projection_usage_contributions c
      WHERE c.thread_id = t.thread_id AND c.turn_id = t.turn_id)
    AND NOT EXISTS (SELECT 1 FROM projection_usage_contributions c
      WHERE c.thread_id = t.thread_id AND c.turn_id IS NULL
        AND COALESCE(json_extract(c.accounting_json, '$.source'), 'legacy') = 'legacy')
), observable_messages AS (
  -- CROSS JOIN keeps eligible turns outermost so each message lookup uses its exact key.
  -- Otherwise SQLite can reorder this into a lifetime message scan.
  SELECT t.*, m.role, m.observable_token_count, m.observable_estimator_version
  FROM observable_turns t
  CROSS JOIN projection_thread_messages m ON m.thread_id = t.thread_id AND m.turn_id = t.turn_id
  WHERE m.role = 'user' OR (m.role = 'assistant' AND m.is_streaming = 0)
  UNION ALL
  SELECT t.*, m.role, m.observable_token_count, m.observable_estimator_version
  FROM observable_turns t
  CROSS JOIN projection_thread_messages m ON m.thread_id = t.thread_id AND m.message_id = t.pending_message_id
  WHERE m.role = 'user' AND m.turn_id IS NOT t.turn_id
), observable AS (
  SELECT thread_id, turn_id, requested_at,
    effective_provider AS provider, effective_model AS model, effective_mode AS interaction_mode,
    SUM(CASE WHEN role = 'user' THEN observable_token_count ELSE 0 END) AS input_tokens,
    SUM(CASE WHEN role = 'assistant' THEN observable_token_count ELSE 0 END) AS output_tokens
  FROM observable_messages
  GROUP BY thread_id, turn_id
  HAVING SUM(CASE WHEN observable_token_count IS NULL
    OR observable_estimator_version IS NOT 'observable-text-v1' THEN 1 ELSE 0 END) = 0
), effective AS (
  SELECT c.contribution_id, c.thread_id, c.turn_id,
    CASE WHEN json_extract(c.accounting_json, '$.source') = 'provider-reported' THEN COALESCE(t.requested_at, c.occurred_at)
      ELSE c.occurred_at END AS occurred_at,
    CASE WHEN c.provider = 'unknown' AND (c.model = 'unknown' OR c.model = t.effective_model)
      THEN COALESCE(t.effective_provider, c.provider) ELSE c.provider END AS provider,
    CASE WHEN c.model = 'unknown' AND (c.provider = 'unknown' OR c.provider = t.effective_provider)
      THEN COALESCE(t.effective_model, c.model) ELSE c.model END AS model,
    c.interaction_mode, c.used_tokens, c.input_tokens,
    c.cached_input_tokens, c.output_tokens, c.reasoning_output_tokens, c.accounting_json,
    'provider-reported' AS source
  FROM official c LEFT JOIN attributed_turns t ON t.thread_id = c.thread_id AND t.turn_id = c.turn_id
  UNION ALL
  SELECT 'estimate:v1:' || thread_id || ':' || turn_id, thread_id, turn_id, requested_at,
    provider, model, interaction_mode, input_tokens + output_tokens, input_tokens, 0, output_tokens, 0,
    json_object('version', 2, 'source', 'estimated', 'basis', 'observable-text-v1',
      'completeness', 'partial', 'inputTokens', input_tokens, 'outputTokens', output_tokens,
      'cacheReadTokens', NULL, 'cacheWriteTokens', NULL, 'reasoningTokens', NULL,
      'reportedTotal', NULL, 'subtotal', input_tokens + output_tokens), 'estimated'
  FROM observable
)`;
}

export const EFFECTIVE_USAGE_CTE = makeEffectiveUsageCte();
// Dates, tokens and overlap suppression do not depend on provider/model attribution; kept as a
// separate name for the streak query.
export const EFFECTIVE_USAGE_DAYS_CTE = EFFECTIVE_USAGE_CTE;
