import { CommandId, EventId, MessageId, ProjectId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { BaseTestLayer } from "./ProjectionPipeline.test.helpers.ts";

const layer = it.layer(BaseTestLayer);

layer("project last-used projection", (it) => {
  it.effect("replays meaningful thread activity without using the snapshot", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.makeUnsafe("project-last-used");
      const threadId = ThreadId.makeUnsafe("thread-last-used");
      const createdAt = "2026-01-01T00:00:00.000Z";
      const usedAt = "2026-01-03T00:00:00.000Z";

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("event-project-created"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("command-project-created"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          projectId,
          title: "Project",
          workspaceRoot: "/tmp/project-last-used",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });
      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("event-thread-created"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("command-thread-created"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "Thread",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      });
      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("event-message-sent"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: usedAt,
        commandId: CommandId.makeUnsafe("command-message-sent"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.makeUnsafe("message-last-used"),
          role: "user",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: usedAt,
          updatedAt: usedAt,
        },
      });

      yield* pipeline.bootstrap;

      const rows = yield* sql<{ readonly lastUsedAt: string }>`
        SELECT last_used_at AS "lastUsedAt"
        FROM projection_projects
        WHERE project_id = ${projectId}
      `;
      assert.equal(rows[0]?.lastUsedAt, usedAt);
    }),
  );

  it.effect("derives a missing thread projection identity from canonical history", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.makeUnsafe("project-last-used-restart");
      const threadId = ThreadId.makeUnsafe("thread-last-used-restart");
      const createdAt = "2026-01-01T00:00:00.000Z";
      const usedAt = "2026-01-03T00:00:00.000Z";

      const projectCreated = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("event-project-created-restart"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("command-project-created-restart"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          projectId,
          title: "Project",
          workspaceRoot: "/tmp/project-last-used-restart",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });
      yield* pipeline.projectEvent(projectCreated);
      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("event-thread-created-restart"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("command-thread-created-restart"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "Thread",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      });
      const messageSent = yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("event-message-sent-restart"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: usedAt,
        commandId: CommandId.makeUnsafe("command-message-sent-restart"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.makeUnsafe("message-last-used-restart"),
          role: "user",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: usedAt,
          updatedAt: usedAt,
        },
      });

      yield* pipeline.projectEvent(messageSent);

      const rows = yield* sql<{ readonly lastUsedAt: string }>`
        SELECT last_used_at AS "lastUsedAt"
        FROM projection_projects
        WHERE project_id = ${projectId}
      `;
      assert.equal(rows[0]?.lastUsedAt, usedAt);
    }),
  );
});
