import { ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { DirectResourceCleanupRepository } from "../../persistence/Services/DirectResourceCleanupRepository.ts";

export const prepareProjectCanonicalRows = Effect.fn("prepareProjectCanonicalRows")(function* (
  suffix: string,
  reconcile = false,
) {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* DirectResourceCleanupRepository;
  const projectId = ProjectId.makeUnsafe(`canonical-project-${suffix}`);
  const now = "2026-08-30T00:00:00.000Z";
  const operationId = `project-operation-${suffix}`;
  const eventId = `project-event-${suffix}`;
  const commandId = `project-finalize-${suffix}`;
  const payload = JSON.stringify({ projectId, deletedAt: now });
  yield* sql`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
      command_id, actor_kind, payload_json, metadata_json
    ) VALUES (${eventId}, 'project', ${projectId}, 1, 'project.deleted', ${now},
      ${commandId}, 'server', ${payload}, '{}')
  `;
  const [event] = yield* sql<{ readonly sequence: number }>`
    SELECT sequence FROM orchestration_events WHERE event_id = ${eventId}
  `;
  const deletionSequence = event!.sequence;
  yield* sql`
    INSERT INTO orchestration_command_receipts (
      command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status,
      payload_digest_version, payload_digest
    ) VALUES (${commandId}, 'project', ${projectId}, ${now}, ${deletionSequence}, 'accepted', 'v1', 'digest')
  `;
  yield* sql`
    INSERT INTO projection_baselines (
      sequence, format_version, payload_json, payload_hash, verification_status, created_at, verified_at
    ) VALUES (${deletionSequence}, 1, '{}', ${`project-hash-${suffix}`}, 'verified', ${now}, ${now})
  `;
  yield* sql`
    INSERT INTO orchestration_deletion_markers (
      entity_kind, entity_id, deletion_sequence, deleted_at, covered_by_baseline_sequence
    ) VALUES ('project', ${projectId}, ${deletionSequence}, ${now}, ${deletionSequence})
  `;
  yield* sql`
    INSERT INTO direct_resource_cleanup_intents (
      intent_id, event_id, source_command_id, source_payload_digest_version,
      source_payload_digest, entity_kind, entity_id, deletion_mode, deletion_requested_at
    ) VALUES (${`project-intent-${suffix}`}, ${`project-intent-event-${suffix}`},
      ${`project-source-${suffix}`}, 'v1', 'source', 'project', ${projectId}, 'project', ${now})
  `;
  yield* repository.prepare({
    operationId,
    intentId: `project-intent-${suffix}`,
    finalizeCommandId: commandId,
    finalizePayloadJson: JSON.stringify({
      type: "project.delete.finalize",
      projectId,
      createdAt: now,
    }),
    finalizePayloadDigestVersion: "v1",
    finalizePayloadDigest: "digest",
    planDigest: "plan",
    expectedPlatform: "darwin/arm64",
    resources: [],
    createdAt: now,
  });
  if (reconcile) yield* repository.reconcilePrepared(now, "darwin/arm64");
  else
    yield* repository.markFinalizeCommitted({
      operationId,
      aggregateKind: "project",
      aggregateId: projectId,
      payloadDigestVersion: "v1",
      payloadDigest: "digest",
      eventId,
      eventSequence: deletionSequence,
      eventType: "project.deleted",
      eventPayloadJson: payload,
      provenAt: now,
    });
  return { sql, repository, projectId, operationId, deletionSequence, now };
});
