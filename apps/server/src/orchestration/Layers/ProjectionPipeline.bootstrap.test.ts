import { CommandId, EventId, MessageId, ProjectId, ThreadId } from "@bigbud/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import {
  BaseTestLayer,
  makeProjectionPipelinePrefixedTestLayer,
} from "./ProjectionPipeline.test.helpers.ts";
import { ServerConfig } from "../../startup/config.ts";

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("bootstraps all projection states and writes projection rows", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-1"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-1"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-2"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          projectId: ProjectId.makeUnsafe("project-1"),
          title: "Thread 1",
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
        eventId: EventId.makeUnsafe("evt-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-3"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          messageId: MessageId.makeUnsafe("message-1"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const projectRows = yield* sql<{
        readonly projectId: string;
        readonly title: string;
        readonly scriptsJson: string;
      }>`
        SELECT
          project_id AS "projectId",
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
      `;
      const userProjectRows = projectRows.filter((r) => r.projectId !== "__chats__");
      assert.deepEqual(userProjectRows, [
        { projectId: "project-1", title: "Project 1", scriptsJson: "[]" },
      ]);

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly text: string;
      }>`
        SELECT
          message_id AS "messageId",
          text
        FROM projection_thread_messages
      `;
      assert.deepEqual(messageRows, [{ messageId: "message-1", text: "hello" }]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        ORDER BY projector ASC
      `;
      assert.equal(stateRows.length, Object.keys(ORCHESTRATION_PROJECTOR_NAMES).length);
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, 3);
      }
    }),
  );
});

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-replies-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("persists reply metadata into projection message rows", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = new Date().toISOString();

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe("evt-reply-metadata"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-replies"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-reply-metadata"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-reply-metadata"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-replies"),
            messageId: MessageId.makeUnsafe("message-replies"),
            role: "user",
            text: "follow up",
            replyTo: {
              messageId: MessageId.makeUnsafe("message-parent"),
              role: "assistant",
              createdAt: now,
              excerpt: "Earlier answer",
            },
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly replyToJson: string | null;
        }>`
          SELECT
            reply_to_json AS "replyToJson"
          FROM projection_thread_messages
          WHERE message_id = 'message-replies'
        `;
        assert.equal(rows.length, 1);
        assert.deepEqual(JSON.parse(rows[0]?.replyToJson ?? "null"), {
          messageId: "message-parent",
          role: "assistant",
          createdAt: now,
          excerpt: "Earlier answer",
        });
      }),
    );
  },
);

const engineLayer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-projection-pipeline-engine-dispatch-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

engineLayer("OrchestrationProjectionPipeline via engine dispatch", (it) => {
  it.effect("projects dispatched engine events immediately", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = new Date().toISOString();

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-live-project"),
        projectId: ProjectId.makeUnsafe("project-live"),
        title: "Live Project",
        workspaceRoot: "/tmp/project-live",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      });

      const projectRows = yield* sql<{ readonly title: string; readonly scriptsJson: string }>`
        SELECT
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
        WHERE project_id = 'project-live'
      `;
      assert.deepEqual(projectRows, [{ title: "Live Project", scriptsJson: "[]" }]);

      const projectorRows = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = 'projection.projects'
      `;
      assert.deepEqual(projectorRows, [{ lastAppliedSequence: 1 }]);
    }),
  );

  it.effect("projects persist updated scripts from project.meta.update", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = new Date().toISOString();

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-scripts-project-create"),
        projectId: ProjectId.makeUnsafe("project-scripts"),
        title: "Scripts Project",
        workspaceRoot: "/tmp/project-scripts",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      });

      yield* engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.makeUnsafe("cmd-scripts-project-update"),
        projectId: ProjectId.makeUnsafe("project-scripts"),
        scripts: [
          {
            id: "script-1",
            name: "Build",
            command: "bun run build",
            icon: "build",
            runOnWorktreeCreate: false,
          },
        ],
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
      });

      const projectRows = yield* sql<{
        readonly scriptsJson: string;
        readonly defaultModelSelection: string;
      }>`
        SELECT
          scripts_json AS "scriptsJson",
          default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-scripts'
      `;
      assert.deepEqual(projectRows, [
        {
          scriptsJson:
            '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          defaultModelSelection: '{"provider":"codex","model":"gpt-5"}',
        },
      ]);
    }),
  );
});
