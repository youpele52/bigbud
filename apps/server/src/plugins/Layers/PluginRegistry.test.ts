import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerConfig, type ServerConfigShape } from "../../startup/config";
import { PluginRegistry } from "../Services/PluginRegistry";
import { PluginRegistryLive } from "./PluginRegistry";

const { runGitMock } = vi.hoisted(() => ({ runGitMock: vi.fn() }));
vi.mock("./PluginRegistry.utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./PluginRegistry.utils")>()),
  runGit: runGitMock,
}));

const tempRoots: string[] = [];

function makeConfig(root: string): ServerConfigShape {
  const stateDir = Path.join(root, "userdata");
  return {
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
    dbPath: Path.join(stateDir, "state.sqlite"),
    keybindingsConfigPath: Path.join(stateDir, "keybindings.json"),
    settingsPath: Path.join(stateDir, "settings.json"),
    notesDir: Path.join(stateDir, "notes"),
    kanbanDir: Path.join(stateDir, "kanban"),
    worktreesDir: Path.join(root, "worktrees"),
    attachmentsDir: Path.join(stateDir, "attachments"),
    logsDir: Path.join(stateDir, "logs"),
    serverLogPath: Path.join(stateDir, "logs", "server.log"),
    serverTracePath: Path.join(stateDir, "logs", "server.trace.ndjson"),
    providerLogsDir: Path.join(stateDir, "logs", "provider"),
    providerEventLogPath: Path.join(stateDir, "logs", "provider", "events.log"),
    terminalLogsDir: Path.join(stateDir, "logs", "terminals"),
    anonymousIdPath: Path.join(stateDir, "anonymous-id"),
    pluginsDir: Path.join(stateDir, "plugins"),
    staticDir: undefined,
    mobileWebStaticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
  };
}

afterEach(async () => {
  runGitMock.mockReset();
  await Promise.all(
    tempRoots.splice(0).map((root) => FS.rm(root, { force: true, recursive: true })),
  );
});

describe("PluginRegistryLive", () => {
  it("keeps the server available when marketplace Git is unavailable", async () => {
    const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "bigbud-plugin-registry-"));
    tempRoots.push(root);
    runGitMock.mockRejectedValue(new Error("spawn git ENOENT"));
    const layer = PluginRegistryLive.pipe(
      Layer.provide(Layer.succeed(ServerConfig, makeConfig(root))),
    );

    const catalog = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry;
          return yield* registry.refresh;
        }).pipe(Effect.provide(layer)),
      ),
    );

    expect(catalog.sync).toMatchObject({ status: "unavailable", failure: "git" });
    expect(catalog.sync.lastAttemptedAt).toBeTypeOf("string");
    expect(catalog.items).toEqual([]);
  });
});
