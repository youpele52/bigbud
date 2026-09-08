import * as nodeFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerConfig, type ServerConfigShape } from "../../startup/config.ts";
import { TerminalManager } from "../Services/Manager.ts";
import { PtyAdapter } from "../Services/PTY.ts";
import { TerminalManagerLive } from "./Manager.ts";
import { FakePtyAdapter, openInput } from "./Manager.test.helpers.ts";

const root = path.join(os.tmpdir(), `bigbud-terminal-lease-${randomUUID()}`);
const stateDir = path.join(root, "userdata");
const config: ServerConfigShape = {
  logLevel: "Error",
  traceMinLevel: "Info",
  traceTimingEnabled: false,
  traceBatchWindowMs: 200,
  traceMaxBytes: 1024,
  traceMaxFiles: 1,
  otlpTracesUrl: undefined,
  otlpMetricsUrl: undefined,
  otlpExportIntervalMs: 10_000,
  otlpServiceName: "bigbud-test",
  mode: "desktop",
  port: 0,
  host: "127.0.0.1",
  cwd: root,
  baseDir: root,
  stateDir,
  dbPath: path.join(stateDir, "state.sqlite"),
  keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
  settingsPath: path.join(stateDir, "settings.json"),
  notesDir: path.join(stateDir, "notes"),
  kanbanDir: path.join(stateDir, "kanban"),
  worktreesDir: path.join(root, "worktrees"),
  attachmentsDir: path.join(stateDir, "attachments"),
  logsDir: path.join(stateDir, "logs"),
  serverLogPath: path.join(stateDir, "logs", "server.log"),
  serverTracePath: path.join(stateDir, "logs", "server.trace.ndjson"),
  providerLogsDir: path.join(stateDir, "logs", "provider"),
  providerEventLogPath: path.join(stateDir, "logs", "provider", "events.log"),
  terminalLogsDir: path.join(stateDir, "logs", "terminals"),
  anonymousIdPath: path.join(stateDir, "anonymous-id"),
  pluginsDir: path.join(stateDir, "plugins"),
  staticDir: undefined,
  mobileWebStaticDir: undefined,
  devUrl: undefined,
  noBrowser: true,
  authToken: undefined,
  autoBootstrapProjectFromCwd: false,
  logWebSocketEvents: false,
};
const dependencies = Layer.mergeAll(
  NodeServices.layer,
  SqlitePersistenceMemory,
  Layer.succeed(ServerConfig, config),
  Layer.succeed(PtyAdapter, new FakePtyAdapter()),
);
const layer = Layer.provideMerge(TerminalManagerLive, dependencies);

it.layer(layer, { excludeTestServices: true })("TerminalManagerLive runtime leases", (it) => {
  it.effect("keeps independent leases for terminals sharing a thread and cwd", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const manager = yield* TerminalManager;
      yield* Effect.addFinalizer(() => Effect.promise(() => nodeFs.rm(root, { recursive: true })));
      yield* sql`INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at
      ) VALUES ('thread-1', 'project', 'Lease thread', '{}', 'full-access', 'default', 'now', 'now')`;

      yield* manager.open(openInput({ terminalId: "terminal-one", cwd: process.cwd() }));
      yield* manager.open(openInput({ terminalId: "terminal-two", cwd: process.cwd() }));
      assert.deepEqual(yield* sql`SELECT lease_id FROM worktree_runtime_leases ORDER BY lease_id`, [
        { lease_id: "terminal:thread-1:terminal-one" },
        { lease_id: "terminal:thread-1:terminal-two" },
      ]);

      yield* manager.close({ threadId: "thread-1", terminalId: "terminal-one" });
      assert.deepEqual(yield* sql`SELECT lease_id FROM worktree_runtime_leases`, [
        { lease_id: "terminal:thread-1:terminal-two" },
      ]);
    }),
  );
});
