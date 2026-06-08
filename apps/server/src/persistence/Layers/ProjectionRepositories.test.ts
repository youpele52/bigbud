import { LOCAL_EXECUTION_TARGET_ID, ProjectId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "./ProjectionProjects.ts";
import { ProjectionNoteRepositoryLive } from "./ProjectionNotes.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { ProjectionProjectRepository } from "../Services/ProjectionProjects.ts";
import { ProjectionNoteRepository } from "../Services/ProjectionNotes.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import { ServerConfig } from "../../startup/config.ts";

const baseLayer = Layer.mergeAll(NodeServices.layer, SqlitePersistenceMemory);
const projectLayer = ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(baseLayer));

const makeServerConfigLayer = (tempDir: string) =>
  Layer.succeed(ServerConfig, {
    logLevel: "Error" as const,
    traceMinLevel: "Info" as const,
    traceTimingEnabled: true,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "t3-server",
    mode: "web" as const,
    port: 0,
    host: undefined,
    cwd: process.cwd(),
    baseDir: tempDir,
    stateDir: tempDir,
    dbPath: `${tempDir}/state.sqlite`,
    keybindingsConfigPath: `${tempDir}/keybindings.json`,
    settingsPath: `${tempDir}/settings.json`,
    notesDir: `${tempDir}/notes`,
    worktreesDir: `${tempDir}/worktrees`,
    attachmentsDir: `${tempDir}/attachments`,
    logsDir: `${tempDir}/logs`,
    serverLogPath: `${tempDir}/logs/server.log`,
    serverTracePath: `${tempDir}/logs/server.trace.ndjson`,
    providerLogsDir: `${tempDir}/logs/provider`,
    providerEventLogPath: `${tempDir}/logs/provider/events.log`,
    terminalLogsDir: `${tempDir}/logs/terminals`,
    anonymousIdPath: `${tempDir}/anonymous-id`,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    staticDir: undefined,
    devUrl: undefined,
  });

const projectionRepositoriesLayer = it.layer(
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-notes-test-" });
      const serverConfigLayer = makeServerConfigLayer(tempDir);
      const noteLayer = ProjectionNoteRepositoryLive.pipe(
        Layer.provideMerge(baseLayer),
        Layer.provideMerge(serverConfigLayer),
      );
      const threadLayer = ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(baseLayer));
      return Layer.mergeAll(projectLayer, noteLayer, threadLayer);
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

projectionRepositoriesLayer("Projection repositories", (it) => {
  it.effect("stores SQL NULL for missing project model options", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* projects.upsert({
        projectId: ProjectId.makeUnsafe("project-null-options"),
        title: "Null options project",
        providerRuntimeExecutionTargetId: LOCAL_EXECUTION_TARGET_ID,
        workspaceExecutionTargetId: LOCAL_EXECUTION_TARGET_ID,
        executionTargetId: LOCAL_EXECUTION_TARGET_ID,
        workspaceRoot: "/tmp/project-null-options",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.4",
        },
        scripts: [],
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        deletingAt: null,
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly defaultModelSelection: string | null;
      }>`
        SELECT default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.fail(new Error("Expected projection_projects row to exist."));
      }

      assert.strictEqual(
        row.defaultModelSelection,
        JSON.stringify({
          provider: "codex",
          model: "gpt-5.4",
        }),
      );

      const persisted = yield* projects.getById({
        projectId: ProjectId.makeUnsafe("project-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.defaultModelSelection, {
        provider: "codex",
        model: "gpt-5.4",
      });
    }),
  );

  it.effect("stores JSON for thread model options", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* threads.upsert({
        threadId: ThreadId.makeUnsafe("thread-null-options"),
        projectId: ProjectId.makeUnsafe("project-null-options"),
        title: "Null options thread",
        providerRuntimeExecutionTargetId: LOCAL_EXECUTION_TARGET_ID,
        workspaceExecutionTargetId: LOCAL_EXECUTION_TARGET_ID,
        executionTargetId: LOCAL_EXECUTION_TARGET_ID,
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        archivedAt: null,
        deletingAt: null,
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly modelSelection: string | null;
      }>`
        SELECT model_selection_json AS "modelSelection"
        FROM projection_threads
        WHERE thread_id = 'thread-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.fail(new Error("Expected projection_threads row to exist."));
      }

      assert.strictEqual(
        row.modelSelection,
        JSON.stringify({
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        }),
      );

      const persisted = yield* threads.getById({
        threadId: ThreadId.makeUnsafe("thread-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.modelSelection, {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      });
    }),
  );

  it.effect("lists project and global notes by scope", () =>
    Effect.gen(function* () {
      const notes = yield* ProjectionNoteRepository;

      yield* notes.create({
        projectId: ProjectId.makeUnsafe("project-null-options"),
        title: "Project note",
        content: "project",
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
      });
      yield* notes.create({
        projectId: null,
        title: "Global note",
        content: "global",
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T01:00:00.000Z",
      });

      const projectNotes = yield* notes.list({
        projectId: ProjectId.makeUnsafe("project-null-options"),
        scope: "project",
      });
      const allNotes = yield* notes.list({
        projectId: ProjectId.makeUnsafe("project-null-options"),
        scope: "global",
      });

      assert.deepStrictEqual(
        projectNotes.map((note) => note.title),
        ["Project note"],
      );
      assert.deepStrictEqual(
        allNotes.map((note) => note.title),
        ["Global note", "Project note"],
      );
    }),
  );
});
