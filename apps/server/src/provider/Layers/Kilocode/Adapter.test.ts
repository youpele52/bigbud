import { it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { KilocodeAdapter } from "../../Services/Kilocode/Adapter.ts";
import { makeKilocodeAdapterLive } from "./Adapter.ts";
import { OpencodeServerManager } from "../../Services/Opencode/ServerManager.ts";
import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";

const fakeServerManager = Layer.succeed(OpencodeServerManager, {
  acquire: async () => ({
    client: {} as never,
    url: "http://127.0.0.1:4096",
    release() {},
  }),
});

const layer = it.layer(
  makeKilocodeAdapterLive().pipe(
    Layer.provide(
      Layer.succeed(ServerConfig, {
        logLevel: "Error",
        traceMinLevel: "Info",
        traceTimingEnabled: true,
        traceBatchWindowMs: 200,
        traceMaxBytes: 10 * 1024 * 1024,
        traceMaxFiles: 10,
        otlpTracesUrl: undefined,
        otlpMetricsUrl: undefined,
        otlpExportIntervalMs: 10_000,
        otlpServiceName: "t3-server",
        cwd: "/tmp/cwd",
        baseDir: "/tmp/bigbud-test",
        stateDir: "/tmp/bigbud-test/state",
        dbPath: "/tmp/bigbud-test/bigbud.db",
        keybindingsConfigPath: "/tmp/bigbud-test/keybindings.json",
        settingsPath: "/tmp/bigbud-test/settings.json",
        notesDir: "/tmp/bigbud-test/notes",
        worktreesDir: "/tmp/bigbud-test/worktrees",
        attachmentsDir: "/tmp/bigbud-test/attachments",
        logsDir: "/tmp/bigbud-test/logs",
        serverLogPath: "/tmp/bigbud-test/logs/server.log",
        serverTracePath: "/tmp/bigbud-test/logs/trace.log",
        providerLogsDir: "/tmp/bigbud-test/logs/providers",
        providerEventLogPath: "/tmp/bigbud-test/logs/provider-events.ndjson",
        terminalLogsDir: "/tmp/bigbud-test/logs/terminal",
        anonymousIdPath: "/tmp/bigbud-test/anonymous-id",
        mode: "web",
        port: 3773,
        host: undefined,
        devClientOrigin: undefined,
        logWebSocketEvents: false,
        devUrl: undefined,
      } as never),
    ),
    Layer.provide(
      ServerSettingsService.layerTest({
        providers: {
          kilocode: { enabled: true, binaryPath: "kilo", customModels: [] },
        },
      } as never),
    ),
    Layer.provide(fakeServerManager),
  ),
);

layer("KilocodeAdapter", (it) => {
  it.effect("creates adapter with provider 'kilocode'", () =>
    Effect.gen(function* () {
      const adapter = yield* KilocodeAdapter;
      expect(adapter.provider).toBe("kilocode");
      expect(adapter.capabilities.sessionModelSwitch).toBe("in-session");
    }),
  );

  it.effect("has all required methods", () =>
    Effect.gen(function* () {
      const adapter = yield* KilocodeAdapter;
      expect(typeof adapter.startSession).toBe("function");
      expect(typeof adapter.sendTurn).toBe("function");
      expect(typeof adapter.interruptTurn).toBe("function");
      expect(typeof adapter.respondToRequest).toBe("function");
      expect(typeof adapter.respondToUserInput).toBe("function");
      expect(typeof adapter.stopSession).toBe("function");
      expect(typeof adapter.listSessions).toBe("function");
      expect(typeof adapter.hasSession).toBe("function");
      expect(typeof adapter.readThread).toBe("function");
      expect(typeof adapter.rollbackThread).toBe("function");
      expect(typeof adapter.stopAll).toBe("function");
      expect(adapter.streamEvents).toBeDefined();
    }),
  );
});
