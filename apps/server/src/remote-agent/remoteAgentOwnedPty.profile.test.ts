import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteAgentConnectionPool } from "./remoteAgentConnectionPool.ts";
import type { RemoteAgentOwner, RemoteAgentOwnerStore } from "./remoteAgentOwners.ts";
import {
  profileLaunch,
  profileOwner,
  spawnInput,
} from "./remoteAgentOwnedPty.profile.testUtils.ts";

const f = vi.hoisted(() => ({
  owner: undefined as RemoteAgentOwner | undefined,
  events: [] as string[],
  create: vi.fn(),
  attach: vi.fn(),
  open: vi.fn(),
  getBound: vi.fn(),
  binding: vi.fn(),
  control: vi.fn(),
  rollback: vi.fn(),
  controllerAlive: true,
  pinned: false,
  status: "unconfirmed" as "unconfirmed" | undefined,
  interruption: undefined as string | undefined,
  exitCallbacks: [] as (() => void)[],
  unpinned: false,
}));
function fakeProcess() {
  return {
    pid: 123,
    get launchStatus() {
      return f.status;
    },
    attach: f.attach,
    restoreSequences: vi.fn(),
    setDurability: vi.fn(),
    get interruptionReason() {
      return f.interruption;
    },
    onExit: (callback: () => void) => {
      f.exitCallbacks.push(callback);
      return () => undefined;
    },
    onData: () => () => undefined,
    onError: () => () => undefined,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    close: vi.fn(),
    detach: vi.fn(),
  };
}
vi.mock("./remoteAgentPtyClient.create.ts", () => ({
  RemoteAgentPtyClient: class {
    create = f.create;
  },
}));
vi.mock("./remoteAgentPtyClient.ts", () => ({
  RemoteAgentPtyProcess: function () {
    return fakeProcess();
  },
}));
vi.mock("./remoteAgentWorkspaceClient.ts", () => ({
  RemoteAgentWorkspaceClient: class {
    openWorkspace = f.open;
  },
  RemoteAgentWorkspaceError: class extends Error {},
}));
vi.mock("./remoteAgentAdmission.ts", () => ({
  remoteAgentAdmission: {
    resolveBinding: async () => {
      f.binding();
      return { runtime: profileOwner().runtime, expectedEpoch: "epoch-1" };
    },
  },
}));
vi.mock("./remoteAgentControl.ts", () => ({
  openRemoteAgentControl: async () => {
    f.control();
    return {
      registry: {
        update: async (
          change: (state: { revision: number; pins: { owner: string }[] }) => { pins: unknown[] },
        ) => {
          const next = change({
            revision: 0,
            pins: [{ owner: `terminal:pane:${f.owner?.resourceId}` }],
          });
          if (next.pins.length === 0) f.unpinned = true;
          return next;
        },
      },
    };
  },
}));
vi.mock("./remoteAgentInstall.registry.transitions.ts", () => ({
  pinRemoteAgentBuild: (state: unknown) => {
    f.pinned = true;
    return state;
  },
}));
vi.mock("./remoteAgentController.ts", () => ({
  currentRemoteAgentController: () => ({ id: "controller", pid: 123, startedAt: "now" }),
  isRemoteAgentControllerAlive: async () => f.controllerAlive,
}));
import { makeOwnedRemoteAgentPty } from "./remoteAgentOwnedPty.ts";

function harness(resolveBinding?: Parameters<typeof makeOwnedRemoteAgentPty>[2]) {
  const store = {
    get: async () => f.owner,
    reserve: async (owner: RemoteAgentOwner) => {
      f.events.push("reserve");
      f.owner = owner;
      return owner;
    },
    update: async (_key: string, change: (owner: RemoteAgentOwner) => RemoteAgentOwner) => {
      f.owner = change(f.owner!);
      f.events.push(f.owner.state);
      return f.owner;
    },
    rollbackPrepared: async () => {
      f.rollback();
      if (f.owner?.state !== "prepared") return false;
      f.owner = undefined;
      return true;
    },
  } as unknown as RemoteAgentOwnerStore;
  const pool = {
    getBound: f.getBound,
    onRuntimeRestart: () => () => undefined,
  } as unknown as RemoteAgentConnectionPool;
  return makeOwnedRemoteAgentPty(pool, () => store, resolveBinding);
}
beforeEach(() => {
  vi.clearAllMocks();
  f.owner = undefined;
  f.events = [];
  f.pinned = false;
  f.controllerAlive = true;
  f.status = "unconfirmed";
  f.interruption = undefined;
  f.exitCallbacks = [];
  f.unpinned = false;
  f.getBound.mockResolvedValue({});
  f.open.mockImplementation(async () => {
    f.events.push("workspace");
  });
  f.attach.mockResolvedValue(undefined);
  f.create.mockImplementation(async () => {
    f.events.push("create");
    expect(f.owner?.state).toBe("may-have-been-sent");
    return fakeProcess();
  });
});

describe("owned exact-profile PTY dispatch and recovery", () => {
  for (const explicitProfile of [false, true]) {
    it.each(["missing", "terminal", "dead-prepared"] as const)(
      `recoverOnly rejects %s ownership without protocol traffic (${explicitProfile ? "profile" : "legacy"})`,
      async (state) => {
        const launch = explicitProfile ? profileLaunch() : undefined;
        if (state !== "missing") {
          f.owner = {
            ...profileOwner(launch),
            state: state === "terminal" ? "terminal" : "prepared",
            reservationId: "old-reservation",
            controllerId: "old-controller",
            controllerPid: 123,
            controllerStartedAt: "before",
          };
        }
        const retained = f.owner;
        f.controllerAlive = state !== "dead-prepared";
        await expect(harness()({ ...spawnInput(launch), recoverOnly: true })).rejects.toThrow(
          "no replacement was spawned",
        );
        expect(f.owner).toBe(state === "dead-prepared" ? undefined : retained);
        expect(f.rollback).toHaveBeenCalledTimes(state === "dead-prepared" ? 1 : 0);
        expect(f.events).toEqual([]); // No reservation, state transition, workspace open, or create.
        expect(f.binding).not.toHaveBeenCalled();
        expect(f.getBound).not.toHaveBeenCalled();
        expect(f.control).not.toHaveBeenCalled();
        expect(f.open).not.toHaveBeenCalled();
        expect(f.create).not.toHaveBeenCalled();
        expect(f.attach).not.toHaveBeenCalled();
        expect(f.pinned).toBe(false);
      },
    );
  }

  it("reserves immutable profile intent before dispatch and requires native profile capability", async () => {
    const process = await harness()(spawnInput(profileLaunch()));
    expect(f.events).toEqual(["reserve", "may-have-been-sent", "workspace", "create"]);
    expect(f.owner?.shellLaunch).toEqual(profileLaunch());
    expect(f.getBound.mock.calls[0]?.[2]).toEqual([
      "terminal.pty",
      "workspace.files",
      "terminal.shell-profiles",
    ]);
    expect(f.create.mock.calls[0]?.[0]).toMatchObject({
      shell: "/usr/bin/zsh",
      args: ["-o", "nopromptsp"],
      profileLaunch: true,
      environment: [{ name: "TERM", value: "xterm-256color" }],
      requestDigest: Buffer.from(f.owner!.digest, "hex"),
    });
    expect(process.shellUnconfirmedLaunch).toEqual({
      status: "unconfirmed",
      requestedProfile: profileLaunch().requestedProfile,
    });
    expect(process).not.toHaveProperty("shellLaunchIdentity");
    f.status = undefined;
    expect(process.shellUnconfirmedLaunch).toBeUndefined();
  });

  it.each(["may-have-been-sent", "outcome-unknown"] as const)(
    "only attaches a %s owner, retaining stored intent without caller defaults",
    async (state) => {
      f.owner = { ...profileOwner(profileLaunch()), state };
      const original = f.owner;
      const process = await harness()({ ...spawnInput(), recoverOnly: true });
      expect(f.create).not.toHaveBeenCalled();
      expect(f.open).not.toHaveBeenCalled();
      expect(f.attach).toHaveBeenCalledExactlyOnceWith(0);
      expect(f.owner).toBe(original);
      expect(process.recovered).toBe(true);
      expect(process.shellUnconfirmedLaunch?.requestedProfile).toEqual(
        original.shellLaunch?.requestedProfile,
      );
    },
  );

  it("keeps legacy restored identity unknown and refuses a newly requested profile", async () => {
    f.owner = profileOwner();
    const spawn = harness();
    await expect(spawn(spawnInput(profileLaunch()))).rejects.toThrow("conflicts");
    expect(f.getBound).not.toHaveBeenCalled();
    const process = await spawn(spawnInput());
    expect(process.shellUnconfirmedLaunch).toBeUndefined();
    expect(f.create).not.toHaveBeenCalled();
  });

  it("fails unsupported capability before workspace/create and rolls back only an undispatched reservation", async () => {
    f.getBound.mockRejectedValue(new Error("Unsupported terminal.shell-profiles"));
    await expect(harness()(spawnInput(profileLaunch()))).rejects.toThrow("Unsupported");
    expect(f.owner).toBeUndefined();
    expect(f.open).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.pinned).toBe(false);
  });

  it("retains ownership and pin after a lost create response, then attaches without duplicate dispatch", async () => {
    f.create.mockRejectedValueOnce(new Error("Response lost"));
    const spawn = harness();
    await expect(spawn(spawnInput(profileLaunch()))).rejects.toThrow("Response lost");
    const resourceId = f.owner?.resourceId;
    expect(f.owner?.state).toBe("may-have-been-sent");
    expect(f.owner?.shellLaunch).toEqual(profileLaunch());
    expect(f.pinned).toBe(true);
    await spawn(spawnInput());
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.attach).toHaveBeenCalledTimes(1);
    expect(f.owner?.resourceId).toBe(resourceId);
  });

  it("reuses durable ownership for a custom binary and recovers stored intent after configuration changes", async () => {
    const runtime = {
      ...profileOwner().runtime,
      origin: "legacy-external" as const,
      binaryPath: "/opt/custom/agent",
      statePath: "/home/alice/.bigbud/agent/state",
      socketPath: "/home/alice/.bigbud/agent/state/supervisor.sock",
      logPath: "/home/alice/.bigbud/agent/state/supervisor.log",
    };
    const resolve = vi.fn(async () => ({ runtime, expectedEpoch: "custom-epoch" }));
    f.create.mockRejectedValueOnce(new Error("Response lost"));
    await expect(harness(resolve)(spawnInput(profileLaunch()))).rejects.toThrow("Response lost");
    const retained = f.owner;
    expect(retained).toMatchObject({
      runtime,
      epoch: "custom-epoch",
      shellLaunch: profileLaunch(),
    });
    expect(f.binding).not.toHaveBeenCalled();
    expect(f.pinned).toBe(true);
    const changedConfiguration = vi.fn(async () => {
      throw new Error("must not rediscover");
    });
    const restored = await harness(changedConfiguration)({ ...spawnInput(), recoverOnly: true });
    expect(changedConfiguration).not.toHaveBeenCalled();
    expect(f.owner).toBe(retained);
    expect(f.getBound.mock.lastCall?.[1]).toEqual({ runtime, expectedEpoch: "custom-epoch" });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.attach).toHaveBeenCalledTimes(1);
    expect(restored.shellUnconfirmedLaunch?.requestedProfile).toEqual(
      profileLaunch().requestedProfile,
    );
  });

  it.each([false, true])(
    "releases pins only for definitive exit, not interruption (%s)",
    async (interrupted) => {
      await harness()(spawnInput(profileLaunch()));
      if (interrupted) f.interruption = "remote-service-restarted";
      for (const callback of f.exitCallbacks) callback();
      await vi.waitFor(() =>
        expect(f.owner?.state).toBe(interrupted ? "outcome-unknown" : "terminal"),
      );
      // Flush the persistence continuation that decides whether the pin may be released.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.unpinned).toBe(!interrupted);
    },
  );

  it("never dispatches a second request while a prepared owner is still controlled", async () => {
    f.owner = {
      ...profileOwner(profileLaunch()),
      state: "prepared",
      reservationId: "other",
      controllerId: "controller",
      controllerPid: 123,
      controllerStartedAt: "now",
    };
    await expect(harness()(spawnInput())).rejects.toThrow("Another request");
    expect(f.getBound).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });
});
