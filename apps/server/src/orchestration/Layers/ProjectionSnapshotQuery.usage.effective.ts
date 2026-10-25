/** Recover only an unambiguous, exact historical request; never infer from current thread settings.
 * Shared effective population suppresses overlaps before date filtering or streak calculation.
 */
export const EFFECTIVE_USAGE_CTE = `WITH historical_requests AS (
  SELECT e.stream_id AS thread_id,
    json_extract(e.payload_json, '$.messageId') AS message_id,
    json_extract(e.payload_json, '$.createdAt') AS requested_at,
    MAX(e.payload_json) AS request_json
  FROM orchestration_events e
  WHERE e.aggregate_kind = 'thread' AND e.event_type = 'thread.turn-start-requested'
  GROUP BY e.stream_id, json_extract(e.payload_json, '$.messageId'), json_extract(e.payload_json, '$.createdAt')
  HAVING COUNT(*) = 1
), requested_turns AS (
  SELECT t.*, r.request_json
  FROM projection_turns t
  LEFT JOIN historical_requests r ON r.thread_id = t.thread_id
    AND r.message_id = t.pending_message_id AND r.requested_at = t.requested_at
    AND (t.usage_provider IS NULL OR t.usage_model IS NULL
      OR t.usage_provider = 'unknown' OR t.usage_model = 'unknown')
), attributed_turns AS (
  SELECT t.*,
    COALESCE(NULLIF(t.usage_provider, 'unknown'), json_extract(t.request_json, '$.usageAttribution.provider'),
      json_extract(t.request_json, '$.modelSelection.provider'), 'unknown') AS effective_provider,
    COALESCE(NULLIF(t.usage_model, 'unknown'), json_extract(t.request_json, '$.usageAttribution.model'),
      json_extract(t.request_json, '$.modelSelection.model'), 'unknown') AS effective_model,
    COALESCE(t.usage_interaction_mode, json_extract(t.request_json, '$.interactionMode'), 'unknown') AS effective_mode
  FROM requested_turns t
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
), observable AS (
  SELECT t.thread_id, t.turn_id, t.requested_at,
    t.effective_provider AS provider,
    t.effective_model AS model,
    t.effective_mode AS interaction_mode,
    SUM(CASE WHEN m.role = 'user' THEN m.observable_token_count ELSE 0 END) AS input_tokens,
    SUM(CASE WHEN m.role = 'assistant' THEN m.observable_token_count ELSE 0 END) AS output_tokens
  FROM attributed_turns t
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
