/** Shared effective population: suppress overlaps before filtering dates or calculating streaks. */
export const EFFECTIVE_USAGE_CTE = `WITH official AS (
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
), observable AS (
  SELECT t.thread_id, t.turn_id, t.requested_at,
    COALESCE(t.usage_provider, 'unknown') AS provider,
    COALESCE(t.usage_model, 'unknown') AS model,
    COALESCE(t.usage_interaction_mode, 'unknown') AS interaction_mode,
    SUM(CASE WHEN m.role = 'user' THEN m.observable_token_count ELSE 0 END) AS input_tokens,
    SUM(CASE WHEN m.role = 'assistant' THEN m.observable_token_count ELSE 0 END) AS output_tokens
  FROM projection_turns t
  JOIN projection_thread_messages m ON m.thread_id = t.thread_id
    AND ((m.role = 'user' AND (m.turn_id = t.turn_id OR m.message_id = t.pending_message_id))
      OR (m.role = 'assistant' AND m.turn_id = t.turn_id AND m.is_streaming = 0))
  WHERE t.turn_id IS NOT NULL AND t.started_at IS NOT NULL
    AND t.state IN ('completed', 'error', 'interrupted')
    AND NOT EXISTS (SELECT 1 FROM projection_usage_contributions c
      WHERE c.thread_id = t.thread_id AND (c.turn_id = t.turn_id
        OR (c.turn_id IS NULL AND COALESCE(json_extract(c.accounting_json, '$.source'), 'legacy') = 'legacy')))
  GROUP BY t.thread_id, t.turn_id
  HAVING SUM(CASE WHEN m.observable_token_count IS NULL
    OR m.observable_estimator_version IS NOT 'observable-text-v1' THEN 1 ELSE 0 END) = 0
), effective AS (
  SELECT c.contribution_id, c.thread_id, c.turn_id,
    CASE WHEN json_extract(c.accounting_json, '$.source') = 'provider-reported' THEN COALESCE(t.requested_at, c.occurred_at)
      ELSE c.occurred_at END AS occurred_at,
    c.provider, c.model, c.interaction_mode, c.used_tokens, c.input_tokens,
    c.cached_input_tokens, c.output_tokens, c.reasoning_output_tokens, c.accounting_json,
    'provider-reported' AS source
  FROM official c LEFT JOIN projection_turns t ON t.thread_id = c.thread_id AND t.turn_id = c.turn_id
  UNION ALL
  SELECT 'estimate:v1:' || thread_id || ':' || turn_id, thread_id, turn_id, requested_at,
    provider, model, interaction_mode, input_tokens + output_tokens, input_tokens, 0, output_tokens, 0,
    json_object('version', 2, 'source', 'estimated', 'basis', 'observable-text-v1',
      'completeness', 'partial', 'inputTokens', input_tokens, 'outputTokens', output_tokens,
      'cacheReadTokens', NULL, 'cacheWriteTokens', NULL, 'reasoningTokens', NULL,
      'reportedTotal', NULL, 'subtotal', input_tokens + output_tokens), 'estimated'
  FROM observable
)`;
