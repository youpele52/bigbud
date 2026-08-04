import { ApprovalRequestId, CommandId, EventId, ProjectId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { BaseTestLayer } from "./ProjectionPipeline.test.helpers.ts";

const layer = it.layer(BaseTestLayer);
const threadId = ThreadId.makeUnsafe("pending-input-thread");
const projectId = ProjectId.makeUnsafe("pending-input-project");
const requestId = ApprovalRequestId.makeUnsafe("pending-input-request");

layer("pending user-input projector", (it) => {
  it.effect("replays request and resolution lifecycle and deletes thread-owned rows", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const requestedAt = "2026-01-01T00:00:00.000Z";
      const request = yield* eventStore.append({
        type: "thread.activity-appended",
        eventId: EventId.makeUnsafe("pending-input-event-requested"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: requestedAt,
        commandId: CommandId.makeUnsafe("pending-input-command-requested"),
        causationEventId: null,
        correlationId: null,
        metadata: { requestId },
        payload: {
          threadId,
          activity: {
            id: EventId.makeUnsafe("pending-input-activity-requested"),
            tone: "info",
            kind: "user-input.requested",
            summary: "User input requested",
            payload: {
              requestId,
              questions: [
                {
                  id: "choice",
                  header: "Choice",
                  question: "Continue?",
                  options: [{ label: "Yes", description: "Continue" }],
                  multiSelect: false,
                },
              ],
            },
            turnId: null,
            createdAt: requestedAt,
          },
        },
      });

      yield* pipeline.bootstrap;
      const pending = yield* sql<{ readonly status: string; readonly questions: string }>`
        SELECT status, questions_json AS questions
        FROM projection_pending_user_inputs WHERE request_id = ${requestId}
      `;
      assert.equal(pending[0]?.status, "pending");
      assert.match(pending[0]?.questions ?? "", /Continue/);

      const resolvedAt = "2026-01-01T00:01:00.000Z";
      const resolved = yield* eventStore.append({
        type: "thread.activity-appended",
        eventId: EventId.makeUnsafe("pending-input-event-resolved"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: resolvedAt,
        commandId: CommandId.makeUnsafe("pending-input-command-resolved"),
        causationEventId: request.eventId,
        correlationId: null,
        metadata: { requestId },
        payload: {
          threadId,
          activity: {
            id: EventId.makeUnsafe("pending-input-activity-resolved"),
            tone: "info",
            kind: "user-input.resolved",
            summary: "User input submitted",
            payload: { requestId, answers: { choice: "Yes" } },
            turnId: null,
            createdAt: resolvedAt,
          },
        },
      });
      yield* pipeline.projectEvent(resolved);
      const resolvedRows = yield* sql<{ readonly status: string; readonly resolvedAt: string }>`
        SELECT status, resolved_at AS "resolvedAt"
        FROM projection_pending_user_inputs WHERE request_id = ${requestId}
      `;
      assert.deepEqual(resolvedRows, [{ status: "resolved", resolvedAt }]);

      const deleted = yield* eventStore.append({
        type: "thread.deleted",
        eventId: EventId.makeUnsafe("pending-input-event-thread-deleted"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: resolvedAt,
        commandId: CommandId.makeUnsafe("pending-input-command-thread-deleted"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { threadId, deletedAt: resolvedAt },
      });
      yield* pipeline.projectEvent(deleted);
      const remaining = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_pending_user_inputs WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(remaining, [{ count: 0 }]);
    }),
  );

  it.effect("physically removes project-owned rows before thread projections are deleted", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES (
          ${threadId}, ${projectId}, 'Thread', 'standard',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          '2026-01-01', '2026-01-01'
        )
      `;
      yield* sql`
        INSERT INTO projection_pending_user_inputs (
          request_id, thread_id, status, questions_json, created_at
        ) VALUES (${requestId}, ${threadId}, 'pending', '[]', '2026-01-01')
      `;
      const deleted = yield* eventStore.append({
        type: "project.deleted",
        eventId: EventId.makeUnsafe("pending-input-event-project-deleted"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: "2026-01-02",
        commandId: CommandId.makeUnsafe("pending-input-command-project-deleted"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { projectId, deletedAt: "2026-01-02" },
      });
      yield* pipeline.projectEvent(deleted);
      const remaining = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_pending_user_inputs WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(remaining, [{ count: 0 }]);
    }),
  );

  it.effect("treats provider user-input response failures as terminal", () =>
    Effect.gen(function* () {
      const failureThreadId = ThreadId.makeUnsafe("pending-input-failure-thread");
      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_pending_user_inputs (
          request_id, thread_id, status, questions_json, created_at
        ) VALUES (${requestId}, ${failureThreadId}, 'pending', '[]', '2026-01-01')
      `;
      const failedAt = "2026-01-02";
      const failed = yield* eventStore.append({
        type: "thread.activity-appended",
        eventId: EventId.makeUnsafe("pending-input-event-failed"),
        aggregateKind: "thread",
        aggregateId: failureThreadId,
        occurredAt: failedAt,
        commandId: CommandId.makeUnsafe("pending-input-command-failed"),
        causationEventId: null,
        correlationId: null,
        metadata: { requestId },
        payload: {
          threadId: failureThreadId,
          activity: {
            id: EventId.makeUnsafe("pending-input-activity-failed"),
            tone: "error",
            kind: "provider.user-input.respond.failed",
            summary: "Provider user input response failed",
            payload: { requestId, detail: "Provider rejected the response" },
            turnId: null,
            createdAt: failedAt,
          },
        },
      });
      yield* pipeline.projectEvent(failed);
      const rows = yield* sql<{ readonly status: string; readonly resolvedAt: string }>`
        SELECT status, resolved_at AS "resolvedAt"
        FROM projection_pending_user_inputs WHERE request_id = ${requestId}
      `;
      assert.deepEqual(rows, [{ status: "resolved", resolvedAt: failedAt }]);
    }),
  );
});
