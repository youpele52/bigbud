import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { BaseTestLayer } from "./ProjectionPipeline.test.helpers.ts";

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("resumes from projector last_applied_sequence without replaying older events", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-a1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-a"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-a1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-a1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-a"),
          title: "Project A",
          workspaceRoot: "/tmp/project-a",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-a2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-a"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-a2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-a2"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-a"),
          projectId: ProjectId.makeUnsafe("project-a"),
          title: "Thread A",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-a3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-a"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-a3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-a3"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-a"),
          messageId: MessageId.makeUnsafe("message-a"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-a4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-a"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-a4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-a4"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-a"),
          messageId: MessageId.makeUnsafe("message-a"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;
      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages WHERE message_id = 'message-a'
      `;
      assert.deepEqual(messageRows, [{ text: "hello world" }]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
      `;
      const maxSequenceRows = yield* sql<{ readonly maxSequence: number }>`
        SELECT MAX(sequence) AS "maxSequence" FROM orchestration_events
      `;
      const maxSequence = maxSequenceRows[0]?.maxSequence ?? 0;
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, maxSequence);
      }
    }),
  );

  it.effect("keeps accumulated assistant text when completion payload text is empty", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-empty-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-empty"),
          title: "Project Empty",
          workspaceRoot: "/tmp/project-empty",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-empty-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-empty"),
          projectId: ProjectId.makeUnsafe("project-empty"),
          title: "Thread Empty",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-empty-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-empty"),
          messageId: MessageId.makeUnsafe("assistant-empty"),
          role: "assistant",
          text: "Hello",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-empty-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-empty"),
          messageId: MessageId.makeUnsafe("assistant-empty"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-empty-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-5"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-empty"),
          messageId: MessageId.makeUnsafe("assistant-empty"),
          role: "assistant",
          text: "",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{ readonly text: string; readonly isStreaming: unknown }>`
        SELECT
          text,
          is_streaming AS "isStreaming"
        FROM projection_thread_messages
        WHERE message_id = 'assistant-empty'
      `;
      assert.equal(messageRows.length, 1);
      assert.equal(messageRows[0]?.text, "Hello world");
      assert.isFalse(Boolean(messageRows[0]?.isStreaming));
    }),
  );
});
