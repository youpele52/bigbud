import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  kill: vi.fn(),
  lifecycle: [] as Array<{ scheduleRestart: (reason: string) => void; onDisconnected: () => void }>,
}));

vi.mock("electron", () => ({ app: { isPackaged: false } }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: () => true,
}));
vi.mock("../logging/logging", () => ({
  captureBackendOutput: vi.fn(),
  writeBackendLifecycleEvent: vi.fn(),
  writeBackendSessionBoundary: vi.fn(),
  readPersistedBackendObservabilitySettings: () => ({}),
}));
vi.mock("../env/pathResolver", () => ({
  resolveBackendCwd: () => "/tmp",
  resolveBackendEntry: () => "/tmp/server.mjs",
  resolveBackendLauncherPath: () => "/usr/bin/node",
  resolveBackendNodeExecutable: () => "/usr/bin/node",
  resolvePackagedBundledAgentsDir: () => null,
  resolvePackagedBundledSkillsDir: () => null,
  resolvePackagedOpencodeBinaryDir: () => null,
  resolvePackagedWorkspaceAgentBinary: () => null,
  resolvePackagedDesktopSupervisorBinary: () => null,
}));
vi.mock("./backendProcess", () => ({ killBackendProcess: mocks.kill }));
vi.mock("./backendShutdown", () => ({
  stopBackendChild: vi.fn(),
  stopBackendChildAndWait: vi.fn(),
}));
vi.mock("./backendStartupState", () => ({
  beginBackendStartup: () => 1,
  recordBackendStartupDevelopmentDiagnostics: vi.fn(),
  recordBackendStartupFailure: vi.fn(),
}));
vi.mock("./backendModulesStartup", () => ({
  ensureBackendModulesPath: () => null,
  reportBackendModulesStartupFailure: vi.fn(),
}));
vi.mock("./backendStartupStatusPipe", () => ({ listenForBackendStartupStatus: vi.fn() }));
vi.mock("./backendEnv", () => ({ buildBackendChildEnvironment: () => ({}) }));
vi.mock("./backendRuntimeEnv", () => ({ resolveComputerUseRuntimeEnv: async () => ({}) }));
vi.mock("./backendStartGuard", () => ({
  resolveBackendStartWhenAllowed: (resolve: () => Promise<NodeJS.ProcessEnv>) => resolve(),
}));
vi.mock("./installedProcessQuiescence", () => ({
  isInstalledProcessQuiescing: () => false,
  waitForInstalledProcessStarts: async () => undefined,
}));
vi.mock("../system-monitor/agentBridge", () => ({
  rotateSystemMonitorAgentToken: () => null,
  revokeSystemMonitorAgentToken: vi.fn(),
}));
vi.mock("./backendManager.child", () => ({
  attachBackendChildLifecycle: (
    _child: unknown,
    deps: { scheduleRestart: (reason: string) => void; onDisconnected: () => void },
  ) => {
    mocks.lifecycle.push(deps);
  },
}));

import { initBackendManager, restartUnresponsiveBackend, startBackend } from "./backendManager";

/** A spawned backend whose fd 3 bootstrap envelope the test can read. */
function fakeChild() {
  const bootstrap = new PassThrough();
  let envelope = "";
  bootstrap.on("data", (chunk) => (envelope += String(chunk)));
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdout: null,
    stderr,
    stdio: [null, null, stderr, bootstrap, new PassThrough(), new PassThrough()],
  });
  return { child, envelope: () => JSON.parse(envelope) as Record<string, unknown> };
}

let children: Array<ReturnType<typeof fakeChild>> = [];

beforeEach(() => {
  vi.useFakeTimers();
  children = [];
  mocks.lifecycle.length = 0;
  mocks.spawn.mockImplementation(() => {
    const spawned = fakeChild();
    children.push(spawned);
    return spawned.child;
  });
  initBackendManager({
    rootDir: "/tmp",
    baseDir: "/tmp",
    backendMaxOldSpaceMb: null,
    cuaDriverHostBundleId: "test",
    serverSettingsPath: "/tmp/settings.json",
    getIsQuitting: () => false,
    getBackendLogSink: () => null,
    isDevelopmentDiagnostics: false,
    runId: "run",
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("backend manager start", () => {
  it("spawns with six stdio entries and announces the fd 5 hint pipe", async () => {
    await startBackend();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const stdio = mocks.spawn.mock.calls[0]![2].stdio as ReadonlyArray<string>;
    expect(stdio).toHaveLength(6);
    expect(stdio.slice(3)).toEqual(["pipe", "pipe", "pipe"]);
    expect(children[0]!.envelope()).toMatchObject({ mode: "desktop", lifecycleHintFd: 5 });
    expect(children[0]!.envelope()).not.toHaveProperty("startReason");
    // Clean up the module's single backend for the next test.
    mocks.lifecycle[0]!.onDisconnected();
  });

  it("marks only the start after an unresponsive restart as a resume-probe restart", async () => {
    await startBackend();
    restartUnresponsiveBackend("refused after resume");
    expect(mocks.kill).toHaveBeenCalledWith(children[0]!.child);
    // The killed backend exits and the ordinary restart path starts the replacement.
    mocks.lifecycle[0]!.onDisconnected();
    mocks.lifecycle[0]!.scheduleRestart("exit");
    await vi.advanceTimersByTimeAsync(600);
    expect(children).toHaveLength(2);
    expect(children[1]!.envelope()).toMatchObject({ startReason: "resume-probe-restart" });

    mocks.lifecycle[1]!.onDisconnected();
    mocks.lifecycle[1]!.scheduleRestart("exit");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(3);
    expect(children[2]!.envelope()).not.toHaveProperty("startReason");
    mocks.lifecycle[2]!.onDisconnected();
  });
});
