import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ProjectionKanbanRepositoryLive } from "./ProjectionKanban.ts";
import { ProjectionKanbanRepository } from "../Services/ProjectionKanban.ts";
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

const projectionKanbanLayer = it.layer(
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kanban-test-" });
      const serverConfigLayer = makeServerConfigLayer(tempDir);
      return ProjectionKanbanRepositoryLive.pipe(
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
});
