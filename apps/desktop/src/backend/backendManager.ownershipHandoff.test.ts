import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn(), send: vi.fn() }));
vi.mock("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }],
  },
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  existsSync: () => true,
}));
vi.mock("node:fs/promises", () => ({ realpath: async () => "/state" }));
vi.mock("@bigbud/shared/backendOwnership.record", () => ({
  readOwnershipLock: async () => ({
    pid: 4242,
    startedAt: "start-v2:test:42",
    machineId: "machine",
    nonce: "nonce",
  }),
}));
vi.mock("@bigbud/shared/processStartToken", () => ({
  processStartToken: () => "start-v2:test:42",
  compareProcessStartToken: () => "same",
}));
vi.mock("../logging/logging", () => ({
  captureBackendOutput: vi.fn(),
  writeBackendLifecycleEvent: vi.fn(),
  writeBackendSessionBoundary: vi.fn(),
  readPersistedBackendObservabilitySettings: () => ({}),
}));
vi.mock("../env/pathResolver", () => ({
  resolveBackendCwd: () => "/state",
  resolveBackendEntry: () => "/state/bin.mjs",
  resolveBackendLauncherPath: () => "/node",
  resolveBackendNodeExecutable: () => "/node",
  resolvePackagedBundledAgentsDir: () => null,
  resolvePackagedBundledSkillsDir: () => null,
  resolvePackagedOpencodeBinaryDir: () => null,
  resolvePackagedWorkspaceAgentBinary: () => null,
  resolvePackagedDesktopSupervisorBinary: () => null,
}));
vi.mock("./backendProcess", () => ({ killBackendProcess: mocks.kill }));
vi.mock("./backendModulesStartup", () => ({
  ensureBackendModulesPath: () => null,
  reportBackendModulesStartupFailure: vi.fn(),
}));
vi.mock("./backendEnv", () => ({ buildBackendChildEnvironment: () => ({}) }));
vi.mock("./backendRuntimeEnv", () => ({ resolveComputerUseRuntimeEnv: async () => ({}) }));
vi.mock("../system-monitor/agentBridge", () => ({
  rotateSystemMonitorAgentToken: () => null,
  revokeSystemMonitorAgentToken: vi.fn(),
}));

// Deliberately real: manager, child lifecycle, ownership gate/pipe, and startup publication.
import * as Manager from "./backendManager";
import { configureBackendStartupState, getBackendStartupState } from "./backendStartupState";
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.skipIf(process.platform === "win32")(
  "the production manager wires quiescence, repeat acknowledgments, expected exit and restart suppression",
  async () => {
    vi.useFakeTimers();
    const bootstrap = new PassThrough(),
      status = new PassThrough(),
      hints = new PassThrough();
    const requests = new PassThrough(),
      acknowledgments = new PassThrough(),
      stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: null as number | null,
      signalCode: null,
      stdout: null,
      stderr,
      stdio: [null, null, stderr, bootstrap, status, hints, requests, acknowledgments],
    });
    let envelope = "";
    bootstrap.on("data", (data) => {
      envelope += String(data);
    });
    const replies: unknown[] = [];
    acknowledgments.on("data", (data) => replies.push(JSON.parse(String(data))));
    mocks.spawn.mockReturnValue(child);
    configureBackendStartupState("test-startup", false);
    Manager.initBackendManager({
      rootDir: "/state",
      baseDir: "/state",
      backendMaxOldSpaceMb: null,
      cuaDriverHostBundleId: "test",
      serverSettingsPath: "/state/settings.json",
      getIsQuitting: () => false,
      getBackendLogSink: () => null,
      isDevelopmentDiagnostics: false,
      runId: "test",
    });
    try {
      await Manager.startBackend();
      expect(JSON.parse(envelope)).toMatchObject({ ownershipHandoff: true });
      expect(mocks.spawn.mock.calls[0]![2].stdio).toHaveLength(8);
      Manager.scheduleBackendRestart("queued-before-handoff");
      expect(Manager.restartTimer).not.toBeNull();
      const request = `${JSON.stringify({ operation: "a".repeat(32), identity: JSON.stringify([4242, "start-v2:test:42", "machine", "nonce", "/state"]) })}\n`;
      requests.write(request);
      await vi.waitFor(() => expect(replies).toHaveLength(1));
      expect(Manager.restartTimer).toBeNull();
      expect(getBackendStartupState().ownershipRecovery?.phase).toBe("yielded");
      // Retrying the same private request re-acks without publishing a second transition.
      requests.write(request);
      await vi.waitFor(() => expect(replies).toHaveLength(2));
      expect(replies[1]).toEqual(replies[0]);
      expect(
        mocks.send.mock.calls.filter(([, state]) => state.ownershipRecovery?.phase === "yielded"),
      ).toHaveLength(1);
      child.exitCode = 0;
      child.emit("close", 0, null);
      expect(Manager.backendProcess).toBeNull();
      Manager.scheduleBackendRestart("late-close-callback");
      Manager.restartUnresponsiveBackend("resume");
      await Manager.startBackend();
      await vi.advanceTimersByTimeAsync(60000);
      expect(mocks.spawn).toHaveBeenCalledOnce();
      expect(mocks.kill).not.toHaveBeenCalled();
    } finally {
      child.emit("close", 0, null);
      for (const stream of [bootstrap, status, hints, requests, acknowledgments, stderr])
        stream.destroy();
    }
  },
);
