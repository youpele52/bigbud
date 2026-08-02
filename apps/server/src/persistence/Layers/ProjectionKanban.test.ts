import { utimes } from "node:fs/promises";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Option } from "effect";
import { ProjectId } from "@bigbud/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ProjectionKanbanRepositoryLive } from "./ProjectionKanban.ts";
import { ProjectionNoteRepositoryLive } from "./ProjectionNotes.ts";
import { ProjectionKanbanRepository } from "../Services/ProjectionKanban.ts";
import { ProjectionNoteRepository } from "../Services/ProjectionNotes.ts";
import { ServerConfig } from "../../startup/config.ts";

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
    kanbanDir: `${tempDir}/kanban`,
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
    mobileWebStaticDir: undefined,
    devUrl: undefined,
  });

const projectionKanbanLayer = it.layer(
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kanban-test-" });
      const serverConfigLayer = makeServerConfigLayer(tempDir);
      return Layer.mergeAll(ProjectionKanbanRepositoryLive, ProjectionNoteRepositoryLive).pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(serverConfigLayer),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

projectionKanbanLayer("ProjectionKanban repository", (it) => {
  it.effect("creates, moves, and reorders cards", () =>
    Effect.gen(function* () {
      const kanban = yield* ProjectionKanbanRepository;

      const first = yield* kanban.create({
        projectId: null,
        title: "First",
        content: "# First\n",
        status: "backlog",
        createdAt: "2026-06-23T00:00:00.000Z",
        updatedAt: "2026-06-23T00:00:00.000Z",
      });
      yield* kanban.create({
        projectId: null,
        title: "Second",
        content: "# Second\n",
        status: "backlog",
        createdAt: "2026-06-23T00:00:00.000Z",
        updatedAt: "2026-06-23T00:01:00.000Z",
      });

      yield* kanban.reorderWithinStatus({
        cardId: first.cardId,
        status: "backlog",
        targetIndex: 1,
        updatedAt: "2026-06-23T00:02:00.000Z",
      });

      const listedAfterReorder = yield* kanban.list({ projectId: null, scope: "global" });
      assert.deepStrictEqual(
        listedAfterReorder.map((card) => card.title),
        ["Second", "First"],
      );

      yield* kanban.move({
        cardId: first.cardId,
        status: "todo",
        targetIndex: 0,
        updatedAt: "2026-06-23T00:03:00.000Z",
      });

      const listedAfterMove = yield* kanban.list({ projectId: null, scope: "global" });
      assert.deepStrictEqual(
        listedAfterMove.map((card) => `${card.status}:${card.title}`),
        ["backlog:Second", "todo:First"],
      );
    }),
  );

  it.effect("skips cards with missing or invalid metadata", () =>
    Effect.gen(function* () {
      const kanban = yield* ProjectionKanbanRepository;
      const fs = yield* FileSystem.FileSystem;

      const valid = yield* kanban.create({
        projectId: null,
        title: "Valid",
        content: "# Valid\n",
        status: "backlog",
        createdAt: "2026-06-23T00:00:00.000Z",
        updatedAt: "2026-06-23T00:00:00.000Z",
      });

      const globalDir = valid.absolutePath.slice(0, valid.absolutePath.lastIndexOf("/"));
      yield* fs.writeFileString(`${globalDir}/missing-sidecar.md`, "# Missing sidecar\n");
      yield* fs.writeFileString(`${globalDir}/bad-meta.md`, "# Bad meta\n");
      yield* fs.writeFileString(`${globalDir}/bad-meta.json`, "{");

      const listed = yield* kanban.list({ projectId: null, scope: "global" });
      assert.ok(listed.some((card) => card.title === "Valid"));
      assert.ok(!listed.some((card) => card.absolutePath.endsWith("/missing-sidecar.md")));
      assert.ok(!listed.some((card) => card.absolutePath.endsWith("/bad-meta.md")));
    }),
  );

  it.effect("surfaces external markdown edits through updatedAt", () =>
    Effect.gen(function* () {
      const kanban = yield* ProjectionKanbanRepository;
      const fs = yield* FileSystem.FileSystem;

      const created = yield* kanban.create({
        projectId: null,
        title: "Editable",
        content: "# Editable\n",
        status: "backlog",
        createdAt: "2026-06-23T00:00:00.000Z",
        updatedAt: "2026-06-23T00:00:00.000Z",
      });

      yield* fs.writeFileString(created.absolutePath, "# Edited by agent\n");
      yield* Effect.tryPromise(() =>
        utimes(
          created.absolutePath,
          new Date("2027-06-23T00:05:00.000Z"),
          new Date("2027-06-23T00:05:00.000Z"),
        ),
      );

      const refreshed = yield* kanban.getById({ cardId: created.cardId }).pipe(
        Effect.map((card) => {
          if (card._tag === "None") {
            throw new Error("Expected kanban card to exist");
          }
          return card.value;
        }),
      );

      assert.equal(refreshed.content, "# Edited by agent\n");
      assert.equal(refreshed.updatedAt, "2027-06-23T00:05:00.000Z");
    }),
  );

  it.effect("preserves project card content and rejects stale concurrent mutations", () =>
    Effect.gen(function* () {
      const kanban = yield* ProjectionKanbanRepository;
      const projectId = ProjectId.makeUnsafe("project-agent-kanban");
      const content = "  indented  \n```ts\n  code();\n```\n";
      const created = yield* kanban.create({
        projectId,
        title: "Exact",
        content,
        status: "backlog",
        createdAt: "2026-06-23T00:00:00.000Z",
        updatedAt: "2026-06-23T00:00:00.000Z",
      });
      const loaded = yield* kanban.getById({ cardId: created.cardId });
      assert.equal(Option.getOrThrow(loaded).content, content);

      const update = (updatedAt: string) =>
        kanban.update({
          cardId: created.cardId,
          title: "Changed",
          content,
          expectedUpdatedAt: created.updatedAt,
          updatedAt,
        });
      const exits = yield* Effect.all(
        [
          Effect.exit(update("2026-06-23T00:01:00.000Z")),
          Effect.exit(update("2026-06-23T00:02:00.000Z")),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(exits.filter(Exit.isSuccess).length, 1);
      assert.equal(exits.filter(Exit.isFailure).length, 1);

      const current = Option.getOrThrow(yield* kanban.getById({ cardId: created.cardId }));
      const staleMove = yield* Effect.exit(
        kanban.move({
          cardId: created.cardId,
          status: "todo",
          expectedUpdatedAt: created.updatedAt,
          updatedAt: "2026-06-23T00:03:00.000Z",
        }),
      );
      const staleReorder = yield* Effect.exit(
        kanban.reorderWithinStatus({
          cardId: created.cardId,
          status: current.status,
          targetIndex: 0,
          expectedUpdatedAt: created.updatedAt,
          updatedAt: "2026-06-23T00:04:00.000Z",
        }),
      );
      assert.ok(Exit.isFailure(staleMove));
      assert.ok(Exit.isFailure(staleReorder));
    }),
  );

  it.effect("round-trips project notes exactly and rejects a stale update", () =>
    Effect.gen(function* () {
      const notes = yield* ProjectionNoteRepository;
      const projectId = ProjectId.makeUnsafe("project-agent-notes");
      const content = "  # Exact note  \n\n```ts\n  code();\n```\n";
      const created = yield* notes.create({
        projectId,
        title: "Exact note",
        content,
        createdAt: "2026-06-23T00:00:00.000Z",
        updatedAt: "2026-06-23T00:00:00.000Z",
      });
      const listed = yield* notes.list({ projectId, scope: "project" });
      const loaded = Option.getOrThrow(yield* notes.getById({ noteId: created.noteId }));
      assert.equal(listed[0]?.noteId, created.noteId);
      assert.equal(loaded.projectId, projectId);
      assert.equal(loaded.content, content);

      yield* notes.update({
        noteId: created.noteId,
        title: "Updated",
        content,
        expectedUpdatedAt: loaded.updatedAt,
        updatedAt: "2026-06-23T00:01:00.000Z",
      });
      const stale = yield* Effect.exit(
        notes.update({
          noteId: created.noteId,
          title: "Stale",
          content: "must not win",
          expectedUpdatedAt: loaded.updatedAt,
          updatedAt: "2026-06-23T00:02:00.000Z",
        }),
      );
      assert.ok(Exit.isFailure(stale));
    }),
  );
});
