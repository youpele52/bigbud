/** SQL expression supplied by internal query builders, never user input. Terminal replay is not live work. */
export function unresolvedAdmissionSql(threadExpression: string): string {
  return `SELECT 1 FROM provider_turn_admissions AS admission
    WHERE admission.state IN ('dispatch-intent', 'accepted')
      AND (admission.owner_thread_id = ${threadExpression}
        OR (json_valid(admission.binding_json)
          AND json_extract(admission.binding_json, '$.threadId') = ${threadExpression}))`;
}
