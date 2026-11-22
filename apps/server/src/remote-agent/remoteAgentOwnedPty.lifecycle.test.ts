import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteAgentConnectionPool } from "./remoteAgentConnectionPool.ts";
import type { RemoteAgentOwner, RemoteAgentOwnerStore } from "./remoteAgentOwners.ts";
import {
  profileLaunch,
  profileOwner,
  spawnInput,
  target,
} from "./remoteAgentOwnedPty.profile.testUtils.ts";
import { remoteAgentTerminalWorkspaceHandle } from "./remoteAgentPtyClient.lifecycle.ts";

const f = vi.hoisted(() => ({
  owner: undefined as RemoteAgentOwner | undefined,
  capabilities: new Set<string>(),
  create: vi.fn(),
  open: vi.fn(),
  process: undefined as unknown,
}));

function fakeProcess() {
  return {
    pid: 9,
    launchStatus: undefined,
    attach: vi.fn(async () => undefined),
    setDurability: vi.fn(),
    reconcileInput: vi.fn(async () => undefined),
    onExit: () => () => undefined,
    onData: () => () => undefined,
    onError: () => () => undefined,
    onSequencedData: vi.fn(() => () => undefined),
    screenSnapshot: vi.fn(async () => ({ throughSequence: 3 })),
    lifecycle: {
      evictedPtyId: "evicted",
      capabilities: () => ALL_HOST_CAPABILITIES,
      setViewState: vi.fn(async () => undefined),
      keepOpen: vi.fn(async () => undefined),
      onActivity: vi.fn(() => () => undefined),
      onNotice: vi.fn(() => () => undefined),
      currentConnection: () => ({ supportsCapability: () => false }),
    },
    detach: vi.fn(),
  };
}
vi.mock("./remoteAgentPtyClient.create.ts", () => ({
  RemoteAgentPtyClient: class {
    create = f.create;
  },
}));
vi.mock("./remoteAgentWorkspaceClient.ts", () => ({
  RemoteAgentWorkspaceClient: class {
    openWorkspace = f.open;
  },
  RemoteAgentWorkspaceError: class extends Error {},
}));
vi.mock("./remoteAgentInstall.registry.transitions.ts", () => ({
  pinRemoteAgentBuild: (state: unknown) => state,
}));
vi.mock("./remoteAgentController.ts", () => ({
  currentRemoteAgentController: () => ({ id: "controller", pid: 1, startedAt: "now" }),
  isRemoteAgentControllerAlive: async () => true,
  remoteAgentControllerScopeIssue: () => undefined,
}));
import { makeOwnedRemoteAgentPty } from "./remoteAgentOwnedPty.ts";

const listener = () => undefined;
/** What a protocol 1.9 connection advertises for the whole host. */
const ALL_HOST_CAPABILITIES = {
  screen: true,
  lifecycle: true,
  spool: true,
  queryResponder: true,
  localLaunch: true,
};
const NONE = { screen: false, lifecycle: false, spool: false, queryResponder: false };
const LIFECYCLE_19 = ["terminal.lifecycle", "terminal.screen", "terminal.query-responder"];

function spawn(options?: Parameters<typeof makeOwnedRemoteAgentPty>[3]) {
  const store = {
    get: async () => f.owner,
    reserve: async (owner: RemoteAgentOwner) => (f.owner = owner),
    update: async (_key: string, change: (owner: RemoteAgentOwner) => RemoteAgentOwner) =>
      (f.owner = change(f.owner!)),
    rollbackPrepared: async () => false,
  } as unknown as RemoteAgentOwnerStore;
  const connection = { supportsCapability: (name: string) => f.capabilities.has(name) };
  const pool = {
    getBound: async () => connection,
    onRuntimeRestart: () => () => undefined,
  } as unknown as RemoteAgentConnectionPool;
  const registry = { update: async (change: (state: unknown) => unknown) => change({ pins: [] }) };
  return makeOwnedRemoteAgentPty(
    pool,
    () => store,
    async () => ({ runtime: profileOwner().runtime, expectedEpoch: "epoch-1" }),
    { ...options, openControl: async () => ({ registry }) as never },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  f.owner = undefined;
  f.capabilities = new Set(["terminal.pty", "workspace.files"]);
  f.open.mockResolvedValue(undefined);
  f.create.mockImplementation(async () => (f.process = fakeProcess()));
});

describe("owned PTY protocol 1.9 create", () => {
  it("keeps the legacy per-PTY handle and sends no new fields to an older agent", async () => {
    await spawn({ hostLifecycle: { lifecycleManaged: true, localLaunch: true } })(spawnInput());
    expect(f.open).toHaveBeenCalledExactlyOnceWith(
      `terminal-${f.owner!.resourceId}`,
      "/srv/project",
    );
    expect(f.create.mock.calls[0]![0].lifecycle).toEqual({});
  });

  it("shares a per-cwd root and sends the advertised fields; spawn input overrides defaults", async () => {
    f.capabilities = new Set([
      ...f.capabilities,
      "terminal.lifecycle",
      "terminal.local-launch",
      "terminal.screen",
    ]);
    await spawn({
      hostLifecycle: { lifecycleManaged: true, localLaunch: true, activitySource: "host" },
    })({ ...spawnInput(), hostLifecycle: { activitySource: "owner-hint", evictPtyId: "oldest" } });
    expect(f.open).toHaveBeenCalledExactlyOnceWith(
      remoteAgentTerminalWorkspaceHandle(target, "/srv/project"),
      "/srv/project",
    );
    const request = f.create.mock.calls[0]![0];
    expect(request.workspaceHandle).toBe(
      remoteAgentTerminalWorkspaceHandle(target, "/srv/project"),
    );
    expect(request.lifecycle).toEqual({
      lifecycleManaged: true,
      localLaunch: true,
      activitySource: "owner-hint",
      evictPtyId: "oldest",
    });
  });

  it("sends the full environment only for a local launch the host advertises (S6)", async () => {
    const full = [
      { name: "SECRET_KEY", value: "private" },
      { name: "http_proxy", value: "http://proxy" },
    ];
    const options = {
      hostLifecycle: { lifecycleManaged: true, localLaunch: true },
      localLaunchEnvironment: () => full,
    };
    await spawn(options)(spawnInput(profileLaunch()));
    // Without terminal.local-launch the remote presentation-only environment still applies.
    expect(f.create.mock.calls[0]![0].environment).toEqual([
      { name: "TERM", value: "xterm-256color" },
    ]);
    f.owner = undefined;
    f.capabilities = new Set([...f.capabilities, "terminal.lifecycle", "terminal.local-launch"]);
    await spawn(options)(spawnInput(profileLaunch()));
    const request = f.create.mock.calls[1]![0];
    expect(request.environment).toEqual(full);
    expect(request.lifecycle).toEqual({ lifecycleManaged: true, localLaunch: true });
  });

  it("exposes sequenced output, screen copies and lifecycle controls", async () => {
    f.capabilities = new Set([...f.capabilities, ...LIFECYCLE_19]);
    const pty = await spawn({ hostLifecycle: { lifecycleManaged: true } })(spawnInput());
    const process = f.process as ReturnType<typeof fakeProcess>;
    pty.onSequencedData?.(listener);
    expect(process.onSequencedData).toHaveBeenCalledWith(listener);
    await expect(pty.screen?.snapshot({ attachRenderer: true })).resolves.toEqual({
      throughSequence: 3,
    });
    expect(pty.screen?.capabilities()).toEqual(ALL_HOST_CAPABILITIES);
    expect(f.owner?.hostFeatures).toEqual({ screen: true, lifecycle: true });
    expect(pty.lifecycle?.evictedPtyId).toBe("evicted");
    await pty.lifecycle?.setViewState({ viewState: "hidden", rendererAttached: false });
    await pty.lifecycle?.keepOpen();
    pty.lifecycle?.onNotice(listener);
    pty.lifecycle?.onActivity(listener);
    expect(process.lifecycle.setViewState).toHaveBeenCalledOnce();
    expect(process.lifecycle.keepOpen).toHaveBeenCalledOnce();
    expect(process.lifecycle.onNotice).toHaveBeenCalledWith(listener);
    expect(process.lifecycle.onActivity).toHaveBeenCalledWith(listener);
  });

  it("exposes host-wide controls only for managed remote-agent terminals that ask for them", async () => {
    f.capabilities = new Set([...f.capabilities, ...LIFECYCLE_19]);
    const managed = { hostLifecycle: { lifecycleManaged: true } };
    expect((await spawn(managed)(spawnInput())).lifecycle?.hostWide).toBeUndefined();
    f.owner = undefined;
    const remote = await spawn({ ...managed, remoteHostControls: true })(spawnInput());
    expect(remote.lifecycle?.hostWide?.connectionKey()).toMatch(/^remote-connection-/);
  });

  it("flag off on a 1.9 agent: the PTY reports no screen or lifecycle, exactly as before", async () => {
    f.capabilities = new Set([...f.capabilities, ...LIFECYCLE_19]);
    // No create defaults (the terminal host flag is off): nothing is asked for.
    const pty = await spawn({ remoteHostControls: true })(spawnInput());
    expect(f.create.mock.calls[0]![0].lifecycle).toEqual({});
    expect(f.owner?.hostFeatures).toEqual({ screen: false, lifecycle: false });
    // The connection advertises everything; this PTY has none of it.
    expect(pty.screen?.capabilities()).toMatchObject(NONE);
    expect(pty.lifecycle?.capabilities()).toMatchObject(NONE);
    expect(pty.lifecycle?.hostWide).toBeUndefined();
  });
});
