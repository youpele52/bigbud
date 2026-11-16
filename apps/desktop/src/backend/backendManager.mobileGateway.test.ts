import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn(), send: vi.fn() }));
vi.mock("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }],
  },
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, existsSync: (path: string) => path === "/state/bin.mjs" || fs.existsSync(path) };
});
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  realpath: async () => "/state",
}));
vi.mock("@bigbud/shared/backendOwnership.record", async (original) => ({
  ...(await original<typeof import("@bigbud/shared/backendOwnership.record")>()),
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
  backendChildEnv: () => ({}),
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
vi.mock("./backendPort", () => ({ resolveDesktopBackendPort: async () => 4773 }));
vi.mock("./backendRuntimeEnv", () => ({ resolveComputerUseRuntimeEnv: async () => ({}) }));
vi.mock("../system-monitor/agentBridge", () => ({
  rotateSystemMonitorAgentToken: () => null,
  revokeSystemMonitorAgentToken: vi.fn(),
}));

import { gatewayOwnerFixture, cleanupGatewayFixtures } from "./mobileGatewayOwner.fixtures";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { MobileGatewaySupervisor } from "./mobileGatewaySupervisor";

beforeEach(() => {
  vi.resetModules();
  mocks.spawn.mockReset();
});
afterEach(async () => {
  await cleanupGatewayFixtures();
  vi.useRealTimers();
});

function backendChild() {
  const streams = Array.from({ length: 8 }, () => new PassThrough());
  return Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null,
    stdout: null,
    stderr: streams[2]!,
    stdio: streams,
  });
}
async function setup() {
  const gateway = await gatewayOwnerFixture();
  const Manager = await import("./backendManager");
  const State = await import("./backendStartupState");
  const Preparation = await import("./mobileGatewayPreparation");
  State.configureBackendStartupState("gateway-composition", false);
  Manager.initBackendManager({
    rootDir: "/state",
    baseDir: "/state",
    cuaDriverBaseDir: "/state",
    backendMaxOldSpaceMb: null,
    cuaDriverHostBundleId: "test",
    serverSettingsPath: gateway.input.serverSettingsPath,
    getIsQuitting: () => false,
    getBackendLogSink: () => null,
    isDevelopmentDiagnostics: false,
    runId: "test",
  });
  Manager.setBackendConnectionInfo({
    port: 3773,
    host: "127.0.0.1",
    authToken: "test",
    wsUrl: "ws://localhost",
  });
  Preparation.configureMobileGatewayPreparation(async () => {
    await gateway.owner.prepareDesktopMobileGateway(gateway.input);
  });
  return { gateway, Manager, State };
}
const request =
  JSON.stringify({
    operation: "a".repeat(32),
    identity: JSON.stringify([4242, "start-v2:test:42", "machine", "nonce", "/state"]),
  }) + "\n";

it.each([false, true])(
  "manager handoff waits for gateway exit (first stop fails=%s)",
  async (failFirst) => {
    const { gateway, Manager, State } = await setup();
    let exit!: () => void;
    const held = new Promise<void>((resolve) => {
      exit = resolve;
    });
    gateway.supervisor.stop.mockImplementation(() => held);
    if (failFirst) gateway.supervisor.stop.mockRejectedValueOnce(new Error("exit unconfirmed"));
    const child = backendChild();
    const replies: string[] = [];
    child.stdio[7]!.on("data", (data) => replies.push(String(data)));
    mocks.spawn.mockReturnValue(child);
    await Manager.startBackend();
    child.stdio[6]!.write(request);
    await vi.waitFor(() => expect(gateway.supervisor.stop).toHaveBeenCalledOnce());
    expect(replies).toEqual([]);
    expect(State.getBackendStartupState().ownershipRecovery?.phase).toBe("yielded");
    if (failFirst) {
      await new Promise((resolve) => setImmediate(resolve));
      child.stdio[6]!.write(request);
      await vi.waitFor(() => expect(gateway.supervisor.stop).toHaveBeenCalledTimes(2));
      expect(replies).toEqual([]);
    }
    await Manager.startBackend();
    expect(mocks.spawn).toHaveBeenCalledOnce();
    exit();
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(JSON.parse(replies[0]!)).toMatchObject({ quiesced: true });
    child.exitCode = 0;
    child.emit("close", 0, null);
    Manager.scheduleBackendRestart("late callback");
    expect(Manager.restartTimer).toBeNull();
  },
);

it("owner transfer retries an occupied gateway endpoint and installs its credential in the replacement backend", async () => {
  const { gateway, Manager, State } = await setup();
  gateway.setTarget(4773); // The old owner's gateway is the live, recorded Serve target.
  let occupied = true;
  let childCount = 0;
  const children: ChildProcessWithoutNullStreams[] = [];
  gateway.input.createSupervisor = vi.fn(
    (config) =>
      new MobileGatewaySupervisor(config, {
        spawn: (() => {
          childCount++;
          const child = Object.assign(new EventEmitter(), {
            stdin: new PassThrough(),
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            kill: () => {
              child.emit("close", 0, null);
              return true;
            },
          }) as unknown as ChildProcessWithoutNullStreams;
          children.push(child);
          child.stdin.once("finish", () => child.emit("close", 0, null));
          queueMicrotask(() => {
            if (occupied) child.emit("close", 1, null);
            else
              child.stdout.emit(
                "data",
                JSON.stringify({ event: "ready", listen: "127.0.0.1:4773" }) + "\n",
              );
          });
          return child;
        }) as never,
      }) as never,
  );
  const first = backendChild();
  const second = backendChild();
  mocks.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
  await Manager.startBackend();
  expect(childCount).toBe(1);
  expect(
    mocks.spawn.mock.calls[0]![2].env.BIGBUD_MOBILE_GATEWAY_UPSTREAM_CREDENTIAL,
  ).toBeUndefined();
  first.stdio[4]!.write(
    JSON.stringify({ status: "error", reason: "state_directory_in_use" }) + "\n",
  );
  first.exitCode = 1;
  first.emit("close", 1, null);
  const generation = State.getBackendStartupState().generation;
  const { createOwnershipRecovery } = await import("./ownershipRecovery");
  const { getOwnershipLaunch } = await import("./ownershipRecovery.launch");
  const owner = {
    format: "bigbud.backend-lock.v1" as const,
    pid: 9000,
    port: 3773,
    hostname: "fixture",
    acquiredAt: new Date().toISOString(),
    startedAt: "start-v2:test:42",
    machineId: "machine-v1:" + "a".repeat(64),
    nonce: "a".repeat(32),
    control: { version: 1 as const, port: 3999, secret: "a".repeat(64) },
  };
  let gone = false;
  const actions: string[] = [];
  const recover = createOwnershipRecovery({
    state: State.getBackendStartupState,
    launch: getOwnershipLaunch,
    blocked: () => false,
    childPresent: () => Manager.backendProcess !== null,
    start: Manager.startBackend,
    publish: State.recordOwnershipRecovery,
    platform: "linux",
    machine: () => owner.machineId,
    alive: () => !gone,
    token: () => owner.startedAt,
    verify: async () => undefined,
    canonical: (async () => "/state") as never,
    read: async () => (gone ? undefined : owner),
    request: async (_endpoint, command) => {
      actions.push(command.action);
      if (command.action === "inspect") return "available";
      if (command.action === "prepare") {
        occupied = false;
        return "prepared";
      }
      gone = true;
      return "committed";
    },
  });
  await recover(generation);
  expect(actions).toEqual(["inspect", "prepare", "commit"]);
  expect(childCount).toBe(2);
  expect(Manager.backendProcess).toBe(second);
  expect(gateway.owner.desktopMobileGatewayStatus()).toBe("ready");
  const credential = mocks.spawn.mock.calls[1]![2].env.BIGBUD_MOBILE_GATEWAY_UPSTREAM_CREDENTIAL;
  expect(credential).toHaveLength(64);
  expect(credential).toBe(
    gateway.owner.desktopMobileGatewayEnvironment().BIGBUD_MOBILE_GATEWAY_UPSTREAM_CREDENTIAL,
  );
  expect(gateway.input.ownership.read()).toBe(4773);
  await gateway.owner.stopDesktopMobileGatewayAndWait();
  second.exitCode = 0;
  second.emit("close", 0, null);
  Manager.stopBackend();
});

it("a retry pending at handoff cannot revive the gateway; stale Enable/Disable cannot mutate Serve", async () => {
  const { gateway, Manager } = await setup();
  const children: ChildProcessWithoutNullStreams[] = [];
  gateway.input.createSupervisor = vi.fn(
    (config) =>
      new MobileGatewaySupervisor(config, {
        spawn: (() => {
          const child = Object.assign(new EventEmitter(), {
            stdin: new PassThrough(),
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            kill: vi.fn(() => true),
          }) as unknown as ChildProcessWithoutNullStreams;
          children.push(child);
          queueMicrotask(() =>
            child.stdout.emit(
              "data",
              JSON.stringify({ event: "ready", listen: "127.0.0.1:4773" }) + "\n",
            ),
          );
          return child;
        }) as never,
      }) as never,
  );
  const child = backendChild();
  const replies: string[] = [];
  child.stdio[7]!.on("data", (data) => replies.push(String(data)));
  mocks.spawn.mockReturnValue(child);
  await Manager.startBackend();
  const retry = gateway.owner.retryDesktopMobileGateway();
  const retryRejected = expect(retry).rejects.toThrow("cannot start");
  expect(children[0]!.stdin.writableEnded).toBe(true);
  child.stdio[6]!.write(request);
  const { isOwnershipHandedOff } = await import("./ownershipHandoff");
  await vi.waitFor(() => expect(isOwnershipHandedOff()).toBe(true));
  expect(replies).toEqual([]);
  children[0]!.emit("close", 0, null);
  await retryRejected;
  await vi.waitFor(() => expect(replies).toHaveLength(1));
  expect(children).toHaveLength(1);
  await expect(gateway.owner.retryDesktopMobileGateway()).rejects.toThrow("yielded");
  await gateway.owner.ensureDesktopMobileGateway();
  await expect(gateway.owner.prepareDesktopMobileGateway(gateway.input)).rejects.toThrow(
    "stopping",
  );
  const { makeDesktopMobileRemoteAccess } = await import("../main.bootstrap.tailscale");
  const access = makeDesktopMobileRemoteAccess({
    baseDir: "/fixture",
    getBackendPort: () => 3773,
    getBackendHost: () => "127.0.0.1",
  });
  const execFile = vi
    .spyOn(await import("node:child_process"), "execFile")
    .mockImplementation(() => {
      throw new Error("unexpected native command");
    });
  await expect(access.enableTailscaleRemoteAccess()).rejects.toThrow("yielded");
  await expect(access.disableTailscaleRemoteAccess()).rejects.toThrow("yielded");
  expect(execFile).not.toHaveBeenCalled();
  execFile.mockRestore();
  expect(children).toHaveLength(1);
  expect(mocks.spawn).toHaveBeenCalledOnce();
  child.exitCode = 0;
  child.emit("close", 0, null);
});
