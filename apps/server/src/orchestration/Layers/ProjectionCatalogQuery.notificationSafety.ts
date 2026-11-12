/** Bounded current-run ownership, not transcript history. Requires catalog aliases t and turn. */
export const notificationSafetySql = `json_object(
  'turnId', turn.turn_id,
  'tasks', json((SELECT COALESCE(json_group_array(json(task)), '[]') FROM (
    SELECT json_patch(json_object(
      'id', task_id, 'kind', 'providerSubagent',
      'subject', task_id, 'status', json_extract(task_json, '$.status'),
      'createdAt', created_at, 'updatedAt', updated_at
    ), json_object(
      'turnId', json_extract(task_json, '$.turnId'),
      'background', json(CASE WHEN json_extract(task_json, '$.background') THEN 'true' ELSE 'false' END),
      'parentTaskId', json_extract(task_json, '$.parentTaskId'),
      'parentAgentId', json_extract(task_json, '$.parentAgentId'),
      'freshness', json_extract(task_json, '$.freshness')
    )) AS task
    FROM projection_thread_tasks
    WHERE thread_id = t.thread_id AND json_extract(task_json, '$.kind') = 'providerSubagent'
      AND (json_extract(task_json, '$.turnId') = turn.turn_id OR
        (json_extract(task_json, '$.turnId') IS NULL AND created_at >= turn.requested_at))
    ORDER BY task_id LIMIT 100
  ))),
  'childThreadIds', json((SELECT COALESCE(json_group_array(child_thread_id), '[]') FROM (
    SELECT child_thread_id FROM thread_delegations
    WHERE caller_thread_id = t.thread_id AND created_at >= turn.requested_at
    ORDER BY delegation_id LIMIT 100
  ))),
  'childTurns', json((SELECT COALESCE(json_group_array(json_object(
    'threadId', child_thread_id, 'turnId', native_turn_id,
    'requestMessageId', source_message_id, 'sessionEpoch', native_epoch)), '[]') FROM (
    SELECT d.child_thread_id, d.source_message_id, a.turn_id AS native_turn_id,
      json_extract(a.payload_json, '$.sessionEpoch') AS native_epoch
    FROM thread_delegations d
    LEFT JOIN projection_thread_activities a ON a.activity_id = (
      SELECT binding.activity_id FROM projection_thread_activities binding
      WHERE binding.thread_id = d.child_thread_id
        AND binding.kind = 'text-generation.user-turn-bound'
        AND json_extract(binding.payload_json, '$.messageId') = d.source_message_id
      ORDER BY binding.sequence, binding.created_at, binding.activity_id LIMIT 1
    )
    WHERE d.caller_thread_id = t.thread_id AND d.created_at >= turn.requested_at
    ORDER BY d.delegation_id LIMIT 100
  ))),
  'pendingRequestIds', json((SELECT COALESCE(json_group_array(request_id), '[]') FROM (
    SELECT request_id FROM projection_pending_approvals WHERE thread_id = t.thread_id AND status = 'pending'
    UNION ALL
    SELECT request_id FROM projection_pending_user_inputs WHERE thread_id = t.thread_id AND status = 'pending'
    LIMIT 100
  ))),
  'queuedPromptIds', json((SELECT COALESCE(json_group_array(prompt_id), '[]') FROM (
    SELECT json_extract(value, '$.id') AS prompt_id
    FROM json_each(COALESCE(t.queued_prompts_json, '[]')) LIMIT 100
  ))),
  'pendingStartMessageId', json_extract(t.pending_turn_start_json, '$.messageId'),
  'pendingFlush', CASE WHEN t.pending_interrupt_flush_intent_json IS NOT NULL THEN json_object(
    'intentId', json_extract(t.pending_interrupt_flush_intent_json, '$.intentId'),
    'queuedPromptIds', json((SELECT COALESCE(json_group_array(value), '[]') FROM (
      SELECT value FROM json_each(json_extract(t.pending_interrupt_flush_intent_json, '$.queuedPromptIds')) LIMIT 100
    )))
  ) END,
  'hasActionablePlan', json(CASE WHEN COALESCE(
    (SELECT implemented_at IS NULL FROM projection_thread_proposed_plans p
      WHERE p.thread_id = t.thread_id AND p.turn_id = turn.turn_id
      ORDER BY updated_at DESC, plan_id DESC LIMIT 1),
    (SELECT implemented_at IS NULL FROM projection_thread_proposed_plans p
      WHERE p.thread_id = t.thread_id ORDER BY updated_at DESC, plan_id DESC LIMIT 1)
  ) THEN 'true' ELSE 'false' END),
  'selectedPlan', json(COALESCE(
    (SELECT json_object('id', plan_id, 'turnId', turn_id, 'updatedAt', updated_at, 'implementedAt', implemented_at)
      FROM projection_thread_proposed_plans p WHERE p.thread_id = t.thread_id AND p.turn_id = turn.turn_id
      ORDER BY updated_at DESC, plan_id DESC LIMIT 1),
    (SELECT json_object('id', plan_id, 'turnId', turn_id, 'updatedAt', updated_at, 'implementedAt', implemented_at)
      FROM projection_thread_proposed_plans p WHERE p.thread_id = t.thread_id
      ORDER BY updated_at DESC, plan_id DESC LIMIT 1)
  )),
  'overflow', json('false')
)`;
