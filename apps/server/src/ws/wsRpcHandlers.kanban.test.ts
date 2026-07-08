import { KanbanCardId, WS_METHODS } from "@bigbud/contracts";
import { Effect, Exit, Layer, Option, Cause, FileSystem } from "effect";
import { describe, expect, it } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ProjectionKanbanRepositoryLive } from "../persistence/Layers/ProjectionKanban.ts";
import { ProjectionKanbanRepository } from "../persistence/Services/ProjectionKanban.ts";
import { ServerConfig } from "../startup/config.ts";
import type { WsRpcContext } from "./wsRpcContext";
import { makeWsRpcKanbanHandlers } from "./wsRpcHandlers.kanban.ts";

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

const kanbanTestLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kanban-rpc-" });
    return ProjectionKanbanRepositoryLive.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(makeServerConfigLayer(tempDir)),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

function makeHandlers(projectionKanban: WsRpcContext["projectionKanban"]) {
  return makeWsRpcKanbanHandlers({
    ...({} as WsRpcContext),
    projectionKanban,
  });
}

describe("wsRpcHandlers.kanban", () => {
  it("returns not found when loading a missing card", async () => {
    const exit = await Effect.gen(function* () {
      const kanban = yield* ProjectionKanbanRepository;
      const handlers = makeHandlers(kanban);
      return yield* Effect.exit(
        handlers[WS_METHODS.kanbanGet]({
          cardId: KanbanCardId.makeUnsafe("kanban/global/missing.md"),
        }),
      );
    }).pipe(Effect.provide(kanbanTestLayer), Effect.runPromise);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(error)).toBe(true);
      if (Option.isSome(error)) {
        expect(error.value._tag).toBe("KanbanGetError");
      }
    }
  });

  it("reorders cards through the RPC handler", async () => {
    const result = await Effect.gen(function* () {
      const kanban = yield* ProjectionKanbanRepository;
      const handlers = makeHandlers(kanban);

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

      yield* handlers[WS_METHODS.kanbanReorder]({
        cardId: first.cardId,
        status: "backlog",
        targetIndex: 1,
      });

      return yield* kanban.list({ projectId: null, scope: "global" });
    }).pipe(Effect.provide(kanbanTestLayer), Effect.runPromise);

    expect(result.map((card) => card.title)).toEqual(["Second", "First"]);
  });

  it("rejects stale kanban updates", async () => {
    const exit = await Effect.gen(function* () {
      const kanban = yield* ProjectionKanbanRepository;
      const handlers = makeHandlers(kanban);

      const created = yield* handlers[WS_METHODS.kanbanCreate]({
        projectId: null,
        title: "Stale",
        content: "# Stale\n",
        status: "backlog",
      });

      return yield* Effect.exit(
        handlers[WS_METHODS.kanbanUpdate]({
          cardId: created.cardId,
          title: "Stale",
          content: "# Updated\n",
          expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    }).pipe(Effect.provide(kanbanTestLayer), Effect.runPromise);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(error)).toBe(true);
      if (Option.isSome(error)) {
        expect(error.value._tag).toBe("KanbanUpdateError");
        expect(error.value.message).toContain("changed since you opened it");
      }
    }
  });
});
