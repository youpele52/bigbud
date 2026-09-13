import { LOCAL_EXECUTION_TARGET_ID, ProjectId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Exit, FileSystem, Fiber, Layer, Option } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionKanbanRepository } from "../Services/ProjectionKanban.ts";
import { ProjectionNoteRepository } from "../Services/ProjectionNotes.ts";
import { ProjectionKanbanRepositoryLive } from "./ProjectionKanban.ts";
import { ProjectionNoteRepositoryLive } from "./ProjectionNotes.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ServerConfig } from "../../startup/config.ts";

type Gate = {
  readonly started: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
};

const noteGate: { current: Gate | undefined } = { current: undefined };
const kanbanGate: { current: Gate | undefined } = { current: undefined };
const writesBlocked = { current: false };

const controlledFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const real = yield* FileSystem.FileSystem;
    const gateFor = (filePath: string) => {
      if (!writesBlocked.current) return undefined;
      if (filePath.includes("/notes/")) {
        const gate = noteGate.current;
        noteGate.current = undefined;
        return gate;
      }
      if (filePath.includes("/kanban/")) {
        const gate = kanbanGate.current;
        kanbanGate.current = undefined;
        return gate;
      }
      return undefined;
    };

    return {
      ...real,
      writeFileString: (...args: Parameters<FileSystem.FileSystem["writeFileString"]>) => {
        const [filePath, data, options] = args;
        const gate = gateFor(filePath);
        if (!gate) return real.writeFileString(...args);
        return Effect.gen(function* () {
          yield* Deferred.succeed(gate.started, undefined);
          yield* Deferred.await(gate.release);
          yield* real.writeFileString(filePath, data, options);
        });
      },
    };
  }),
).pipe(Layer.provide(NodeServices.layer));

const layer = it.layer(
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "bigbud-resource-race-" });
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
      const base = Layer.mergeAll(
        NodeServices.layer,
        controlledFileSystem,
        SqlitePersistenceMemory,
      );
      return Layer.mergeAll(ProjectionKanbanRepositoryLive, ProjectionNoteRepositoryLive).pipe(
        Layer.provideMerge(base),
        Layer.provideMerge(config),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

layer("Projection resource mutation races", (it) => {
  it.effect("drains admitted writes before removal and rejects queued writes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const kanban = yield* ProjectionKanbanRepository;
      const notes = yield* ProjectionNoteRepository;
      const config = yield* ServerConfig;
      const projectId = ProjectId.makeUnsafe("race-project");
      const timestamp = "2026-09-13T00:00:00.000Z";
      writesBlocked.current = false;
      noteGate.current = undefined;
      kanbanGate.current = undefined;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, execution_target_id, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (${projectId}, 'Race', ${LOCAL_EXECUTION_TARGET_ID}, '/tmp/race', '[]', 'now', 'now')
      `;
      const note = yield* notes.create({
        projectId,
        title: "Original note",
        content: "original note",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const card = yield* kanban.create({
        projectId,
        title: "Original card",
        content: "original card",
        status: "backlog",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const noteStarted = yield* Deferred.make<void>();
      const noteRelease = yield* Deferred.make<void>();
      const kanbanStarted = yield* Deferred.make<void>();
      const kanbanRelease = yield* Deferred.make<void>();
      noteGate.current = { started: noteStarted, release: noteRelease };
      kanbanGate.current = { started: kanbanStarted, release: kanbanRelease };
      writesBlocked.current = true;

      const admittedNote = yield* Effect.forkChild(
        notes.create({
          projectId,
          title: "Admitted note",
          content: "admitted note",
          createdAt: "2026-09-13T00:01:00.000Z",
          updatedAt: "2026-09-13T00:01:00.000Z",
        }),
      );
      yield* Deferred.await(noteStarted);
      const admittedCard = yield* Effect.forkChild(
        kanban.update({
          cardId: card.cardId,
          title: "Admitted card",
          content: "admitted card",
          updatedAt: "2026-09-13T00:01:00.000Z",
        }),
      );
      yield* Deferred.await(kanbanStarted);
      yield* sql`UPDATE projection_projects SET deleting_at = 'now' WHERE project_id = ${projectId}`;

      const queuedNote = yield* Effect.forkChild(
        Effect.exit(notes.deleteById({ noteId: note.noteId })),
      );
      const queuedCard = yield* Effect.forkChild(
        Effect.exit(
          kanban.reorderWithinStatus({
            cardId: card.cardId,
            status: "backlog",
            targetIndex: 0,
            updatedAt: "2026-09-13T00:02:00.000Z",
          }),
        ),
      );
      const noteDrainFinished = yield* Deferred.make<void>();
      const kanbanDrainFinished = yield* Deferred.make<void>();
      const noteDrainStarted = yield* Deferred.make<void>();
      const kanbanDrainStarted = yield* Deferred.make<void>();
      const noteDrain = yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* Deferred.succeed(noteDrainStarted, undefined);
          yield* notes.drainMutations;
          yield* Deferred.succeed(noteDrainFinished, undefined);
        }),
      );
      const kanbanDrain = yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* Deferred.succeed(kanbanDrainStarted, undefined);
          yield* kanban.drainMutations;
          yield* Deferred.succeed(kanbanDrainFinished, undefined);
        }),
      );
      yield* Deferred.await(noteDrainStarted);
      yield* Deferred.await(kanbanDrainStarted);
      const removalStarted = yield* Deferred.make<void>();
      const removal = yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* Fiber.join(noteDrain);
          yield* Fiber.join(kanbanDrain);
          yield* Deferred.succeed(removalStarted, undefined);
          yield* fs.remove(`${config.notesDir}/${projectId}`, { recursive: true });
          yield* fs.remove(`${config.kanbanDir}/${projectId}`, { recursive: true });
        }),
      );
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* Deferred.poll(noteDrainFinished)));
      assert.isTrue(Option.isNone(yield* Deferred.poll(kanbanDrainFinished)));
      assert.isTrue(Option.isNone(yield* Deferred.poll(removalStarted)));

      writesBlocked.current = false;
      yield* Deferred.succeed(noteRelease, undefined);
      yield* Deferred.succeed(kanbanRelease, undefined);
      const admittedNoteValue = yield* Fiber.join(admittedNote);
      const admittedCardValue = yield* Fiber.join(admittedCard);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(queuedNote)));
      assert.isTrue(Exit.isFailure(yield* Fiber.join(queuedCard)));
      assert.equal(admittedNoteValue.content, "admitted note");
      assert.equal(admittedCardValue.content, "admitted card");
      yield* Fiber.join(noteDrain);
      yield* Fiber.join(kanbanDrain);
      yield* Fiber.join(removal);
      assert.isTrue(Option.isSome(yield* Deferred.poll(noteDrainFinished)));
      assert.isTrue(Option.isSome(yield* Deferred.poll(kanbanDrainFinished)));

      assert.isFalse(yield* fs.exists(`${config.notesDir}/${projectId}`));
      assert.isFalse(yield* fs.exists(`${config.kanbanDir}/${projectId}`));

      yield* sql`UPDATE projection_projects SET deleting_at = NULL WHERE project_id = ${projectId}`;
      const reopenedNote = yield* notes.create({
        projectId,
        title: "Reopened note",
        content: "reopened note",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const reopenedCard = yield* kanban.create({
        projectId,
        title: "Reopened card",
        content: "reopened card",
        status: "backlog",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      assert.equal(reopenedNote.projectId, projectId);
      assert.equal(reopenedCard.projectId, projectId);
      assert.isFalse(Option.isNone(yield* notes.getById({ noteId: reopenedNote.noteId })));
      assert.isFalse(Option.isNone(yield* kanban.getById({ cardId: reopenedCard.cardId })));
    }),
  );
});
