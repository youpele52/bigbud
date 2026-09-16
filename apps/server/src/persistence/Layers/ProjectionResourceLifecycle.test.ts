import { LOCAL_EXECUTION_TARGET_ID, ProjectId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionKanbanRepository } from "../Services/ProjectionKanban.ts";
import { ProjectionNoteRepository } from "../Services/ProjectionNotes.ts";
import { ProjectionKanbanRepositoryLive } from "./ProjectionKanban.ts";
import { ProjectionNoteRepositoryLive } from "./ProjectionNotes.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ServerConfig } from "../../startup/config.ts";

const layer = it.layer(
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "bigbud-resource-lifecycle-" });
      const config = Layer.succeed(ServerConfig, {
        logLevel: "Error" as const,
        traceMinLevel: "Info" as const,
        traceTimingEnabled: true,
        traceBatchWindowMs: 200,
        traceMaxBytes: 10 * 1024 * 1024,
        traceMaxFiles: 10,
        otlpTracesUrl: undefined,
        otlpMetricsUrl: undefined,
        otlpExportIntervalMs: 10_000,
        otlpServiceName: "bigbud-server",
        mode: "web" as const,
        port: 0,
        host: undefined,
        cwd: stateDir,
        baseDir: stateDir,
        stateDir,
        dbPath: `${stateDir}/state.sqlite`,
        keybindingsConfigPath: `${stateDir}/keybindings.json`,
        settingsPath: `${stateDir}/settings.json`,
        notesDir: `${stateDir}/notes`,
        kanbanDir: `${stateDir}/kanban`,
        worktreesDir: `${stateDir}/worktrees`,
        attachmentsDir: `${stateDir}/attachments`,
        logsDir: `${stateDir}/logs`,
        serverLogPath: `${stateDir}/logs/server.log`,
        serverTracePath: `${stateDir}/logs/server.trace.ndjson`,
        providerLogsDir: `${stateDir}/logs/provider`,
        providerEventLogPath: `${stateDir}/logs/provider/events.log`,
        terminalLogsDir: `${stateDir}/logs/terminals`,
        anonymousIdPath: `${stateDir}/anonymous-id`,
        noBrowser: true,
        logWebSocketEvents: false,
        authToken: undefined,
        autoBootstrapProjectFromCwd: false,
        staticDir: undefined,
        mobileWebStaticDir: undefined,
        devUrl: undefined,
      });
      return Layer.mergeAll(ProjectionKanbanRepositoryLive, ProjectionNoteRepositoryLive).pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(config),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

layer("Projection resource lifecycle", (it) => {
  it.effect("rejects every project mutation after deletion starts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const kanban = yield* ProjectionKanbanRepository;
      const notes = yield* ProjectionNoteRepository;
      const projectId = ProjectId.makeUnsafe("lifecycle-project");
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, execution_target_id, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (${projectId}, 'Lifecycle', ${LOCAL_EXECUTION_TARGET_ID}, '/tmp/lifecycle', '[]', 'now', 'now')
      `;
      const card = yield* kanban.create({
        projectId,
        title: "Card",
        content: "# Card\n",
        status: "backlog",
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z",
      });
      const note = yield* notes.create({
        projectId,
        title: "Note",
        content: "# Note\n",
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z",
      });
      yield* sql`UPDATE projection_projects SET deleting_at = 'now' WHERE project_id = ${projectId}`;

      const exits = yield* Effect.all(
        [
          kanban.create({
            projectId,
            title: "New",
            content: "new",
            status: "backlog",
            createdAt: "2026-09-03T00:00:00.000Z",
            updatedAt: "2026-09-03T00:00:00.000Z",
          }),
          kanban.update({
            cardId: card.cardId,
            title: "Updated",
            content: "updated",
            updatedAt: "2026-09-03T00:01:00.000Z",
          }),
          kanban.move({
            cardId: card.cardId,
            status: "todo",
            updatedAt: "2026-09-03T00:01:00.000Z",
          }),
          kanban.reorderWithinStatus({
            cardId: card.cardId,
            status: "backlog",
            targetIndex: 0,
            updatedAt: "2026-09-03T00:01:00.000Z",
          }),
          kanban.deleteById({ cardId: card.cardId }),
          notes.create({
            projectId,
            title: "New",
            content: "new",
            createdAt: "2026-09-03T00:00:00.000Z",
            updatedAt: "2026-09-03T00:00:00.000Z",
          }),
          notes.update({
            noteId: note.noteId,
            title: "Updated",
            content: "updated",
            updatedAt: "2026-09-03T00:01:00.000Z",
          }),
          notes.deleteById({ noteId: note.noteId }),
        ].map((effect) => Effect.exit(effect)),
        { concurrency: "unbounded" },
      );
      assert.isTrue(exits.every(Exit.isFailure));
      assert.isTrue(
        (yield* kanban.list({ projectId, scope: "project" })).some(
          (entry) => entry.cardId === card.cardId,
        ),
      );
      assert.isTrue(
        (yield* notes.list({ projectId, scope: "project" })).some(
          (entry) => entry.noteId === note.noteId,
        ),
      );
    }),
  );

  it.effect(
    "keeps global resources visible with stale project context and reopens after abort",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const kanban = yield* ProjectionKanbanRepository;
        const notes = yield* ProjectionNoteRepository;
        const globalCard = yield* kanban.create({
          projectId: null,
          title: "Global card",
          content: "global",
          status: "backlog",
          createdAt: "2026-09-03T00:00:00.000Z",
          updatedAt: "2026-09-03T00:00:00.000Z",
        });
        const globalNote = yield* notes.create({
          projectId: null,
          title: "Global note",
          content: "global",
          createdAt: "2026-09-03T00:00:00.000Z",
          updatedAt: "2026-09-03T00:00:00.000Z",
        });
        const staleProject = ProjectId.makeUnsafe("stale-project");
        assert.isTrue(
          (yield* kanban.list({ projectId: staleProject, scope: "global" })).some(
            (entry) => entry.cardId === globalCard.cardId,
          ),
        );
        assert.isTrue(
          (yield* notes.list({ projectId: staleProject, scope: "global" })).some(
            (entry) => entry.noteId === globalNote.noteId,
          ),
        );

        const projectId = ProjectId.makeUnsafe("aborted-project");
        yield* sql`
        INSERT INTO projection_projects (
          project_id, title, execution_target_id, workspace_root, scripts_json, created_at, updated_at, deleting_at
        ) VALUES (${projectId}, 'Aborted', ${LOCAL_EXECUTION_TARGET_ID}, '/tmp/aborted', '[]', 'now', 'now', 'now')
      `;
        const rejected = yield* Effect.exit(
          notes.create({
            projectId,
            title: "Rejected",
            content: "rejected",
            createdAt: "2026-09-03T00:00:00.000Z",
            updatedAt: "2026-09-03T00:00:00.000Z",
          }),
        );
        assert.isTrue(Exit.isFailure(rejected));
        yield* sql`UPDATE projection_projects SET deleting_at = NULL WHERE project_id = ${projectId}`;
        const reopened = yield* notes.create({
          projectId,
          title: "Reopened",
          content: "reopened",
          createdAt: "2026-09-03T00:00:00.000Z",
          updatedAt: "2026-09-03T00:00:00.000Z",
        });
        assert.equal(reopened.projectId, projectId);
      }),
  );
});
