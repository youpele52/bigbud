import { afterEach, describe, expect, it, vi } from "vitest";
import { makeOwnedRemoteAgentProcess } from "./remoteAgentOwnedProcess.ts";
import { makeOwnedRemoteAgentPty } from "./remoteAgentOwnedPty.ts";
import { remoteAgentAdmission } from "./remoteAgentAdmission.ts";
import {
  configureRemoteAgentOwners,
  type RemoteAgentOwner,
  type RemoteAgentOwnerStore,
} from "./remoteAgentOwners.ts";
import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool.ts";
import { remoteAgentRequestDigest } from "./remoteAgentRequestDigest.ts";
import * as Control from "./remoteAgentControl.ts";
import { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";
import { makeRemoteAgentWorkspaceMutation } from "./remoteAgentWorkspaceMutation.ts";

const binding: RemoteAgentRuntimeBinding = {
  expectedEpoch: "epoch-1",
  connectionId: "connection-1",
  runtime: {
    generation: "g1",
    version: "0.2.207",
    sha256: "a".repeat(64),
    buildDigest: "fixture",
    targetTriple: "aarch64-unknown-linux-gnu",
    origin: "managed",
    binaryPath: `/tmp/agent/bin/0.2.207/${"a".repeat(64)}/bigbud-remote-agent`,
    statePath: "/tmp/agent/runtimes/g1",
    socketPath: "/tmp/agent/runtimes/g1/supervisor.sock",
    logPath: "/tmp/agent/runtimes/g1/supervisor.log",
  },
};

function fakeStore(initial?: RemoteAgentOwner) {
  let saved = initial;
  const rolledBack: string[] = [];
  const store = {
    get: async () => saved,
    reserve: async (owner: RemoteAgentOwner) => {
      saved ??= owner;
      return saved;
    },
    rollbackPrepared: async (key: string, resourceId: string) => {
      if (
        saved?.ownerKey === key &&
        saved.resourceId === resourceId &&
        saved.state === "prepared"
      ) {
        rolledBack.push(resourceId);
        saved = undefined;
        return true;
      }
      return false;
    },
    update: async (_key: string, transition: (owner: RemoteAgentOwner) => RemoteAgentOwner) => {
      if (!saved) throw new Error("missing owner");
      saved = transition(saved);
      return saved;
    },
    getBinding: async () => undefined,
    bindConnection: async () => undefined,
    referencedBuildIds: async () => new Set<string>(),
  } satisfies RemoteAgentOwnerStore;
  return { store, rolledBack };
}

function preparedOwner(ownerKey: string, digest: string): RemoteAgentOwner {
  return {
    ownerKey,
    reservationId: "winner",
    target: "ssh:target",
    connectionId: "connection-1",
    runtime: binding.runtime,
    epoch: binding.expectedEpoch,
    resourceId: "remote-resource-1",
    digest,
    state: "prepared",
    outputSequence: 0,
    nextInputSequence: 1,
    inputAcknowledged: 0,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("pre-dispatch remote owner failures", () => {
  it("retains a committed local dispatch fence after its acknowledgement is lost and retries attach only", async () => {
    const { store, rolledBack } = fakeStore();
    configureRemoteAgentOwners(store);
    vi.spyOn(remoteAgentAdmission, "resolveBinding").mockResolvedValue(binding);
    vi.spyOn(RemoteAgentWorkspaceClient.prototype, "openWorkspace").mockResolvedValue({} as never);
    const pins: string[] = [];
    vi.spyOn(Control, "openRemoteAgentControl").mockResolvedValue({
      root: "/tmp/agent",
      run: async () => "",
      registry: {
        read: vi.fn(),
        update: async () => {
          pins.push("retained");
          return {} as never;
        },
      },
    });
    const update = store.update;
    vi.spyOn(store, "update").mockImplementationOnce(async (key, transition) => {
      await update(key, transition);
      throw new Error("publication reply lost");
    });
    const request = vi.fn();
    const send = vi.fn(async () => {
      throw new Error("attach-only");
    });
    const run = makeOwnedRemoteAgentProcess({ getBound: async () => ({ request, send }) } as never);
    const input = {
      ownerKey: "process:ambiguous",
      target: "ssh:target",
      cwd: "/workspace",
      request: {
        workspaceHandle: "workspace",
        operationId: "origin",
        requestDigest: new Uint8Array([1]),
        command: "printf",
      },
    };
    await expect(run(input)).rejects.toThrow("publication reply lost");
    expect((await store.get())?.state).toBe("may-have-been-sent");
    expect(rolledBack).toEqual([]);
    await expect(run(input)).rejects.toThrow("attach-only");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "processAttachRequest" }));
    expect(request).not.toHaveBeenCalled();
    expect(pins).toHaveLength(2);
  });

  it.each(["process", "pty", "write"] as const)(
    "preserves uncertain remote pins after a %s pin commit reply is lost",
    async (kind) => {
      const { store, rolledBack } = fakeStore();
      configureRemoteAgentOwners(store);
      vi.spyOn(remoteAgentAdmission, "resolveBinding").mockResolvedValue(binding);
      let pinned = false;
      vi.spyOn(Control, "openRemoteAgentControl").mockResolvedValue({
        root: "/tmp/agent",
        run: async () => "",
        registry: {
          read: vi.fn(),
          update: async () => {
            pinned = true;
            throw new Error("pin reply lost");
          },
        },
      });
      const pool = { getBound: async () => ({}) } as never;
      const run =
        kind === "process"
          ? makeOwnedRemoteAgentProcess(pool)({
              ownerKey: "origin",
              target: "ssh:target",
              cwd: "/workspace",
              request: {
                workspaceHandle: "workspace",
                operationId: "origin",
                requestDigest: new Uint8Array([1]),
                command: "printf",
              },
            })
          : kind === "pty"
            ? makeOwnedRemoteAgentPty(pool)({
                ownerKey: "origin",
                executionTargetId: "ssh:target",
                remoteCwd: "/workspace",
                shell: "/bin/sh",
                cwd: "/workspace",
                cols: 80,
                rows: 24,
                env: {},
              })
            : makeRemoteAgentWorkspaceMutation("ssh:target", binding).prepare(
                "origin",
                new Uint8Array([1]),
              );
      await expect(run).rejects.toThrow("pin reply lost");
      expect(pinned).toBe(true);
      expect(rolledBack).toHaveLength(1);
    },
  );
  it.each(["process", "pty", "write"] as const)(
    "conditionally rolls back %s at pin and local publication boundaries",
    async (kind) => {
      for (const boundary of ["pin", "publication"]) {
        const { store, rolledBack } = fakeStore();
        configureRemoteAgentOwners(store);
        vi.spyOn(remoteAgentAdmission, "resolveBinding").mockResolvedValue(binding);
        vi.spyOn(RemoteAgentWorkspaceClient.prototype, "openWorkspace").mockResolvedValue({
          workspaceHandle: "workspace",
          root: "/workspace",
          errorCode: "",
          errorMessage: "",
        } as never);
        vi.spyOn(Control, "openRemoteAgentControl").mockResolvedValue({
          root: "/tmp/agent",
          run: async () => "",
          registry: {
            read: vi.fn(),
            update: async () => {
              if (boundary === "pin") throw new Error("pin failed");
              return {} as never;
            },
          },
        });
        if (boundary === "publication")
          vi.spyOn(store, "update").mockRejectedValue(new Error("publication failed"));
        const pool = { getBound: async () => ({}) } as never;
        const run = () =>
          kind === "process"
            ? makeOwnedRemoteAgentProcess(pool)({
                ownerKey: "process:boundary",
                target: "ssh:target",
                cwd: "/workspace",
                request: {
                  workspaceHandle: "workspace",
                  operationId: "invocation",
                  requestDigest: new Uint8Array([1]),
                  command: "printf",
                },
              })
            : kind === "pty"
              ? makeOwnedRemoteAgentPty(pool)({
                  ownerKey: "boundary",
                  executionTargetId: "ssh:target",
                  remoteCwd: "/workspace",
                  shell: "/bin/sh",
                  cwd: "/workspace",
                  cols: 80,
                  rows: 24,
                  env: {},
                })
              : makeRemoteAgentWorkspaceMutation("ssh:target", binding).prepare(
                  "boundary",
                  new Uint8Array([1]),
                );
        await expect(run()).rejects.toThrow(`${boundary} failed`);
        expect(rolledBack).toHaveLength(1);
        await expect(run()).rejects.toThrow(`${boundary} failed`);
        expect(rolledBack).toHaveLength(2);
        vi.restoreAllMocks();
      }
    },
  );
  it("does not reserve an owner when binding resolution fails", async () => {
    const { store, rolledBack } = fakeStore();
    configureRemoteAgentOwners(store);
    vi.spyOn(remoteAgentAdmission, "resolveBinding").mockRejectedValue(
      new Error("resolution failed"),
    );
    const runner = makeOwnedRemoteAgentProcess({ getBound: vi.fn() } as never);

    await expect(
      runner({
        ownerKey: "process:resolution",
        target: "ssh:target",
        cwd: "/workspace",
        request: {
          workspaceHandle: "workspace",
          operationId: "operation",
          requestDigest: new Uint8Array([1]),
          command: "printf",
        },
      }),
    ).rejects.toThrow("resolution failed");
    expect(rolledBack).toHaveLength(0);
  });

  it("rolls back a newly reserved process owner when connection setup fails before dispatch", async () => {
    const { store, rolledBack } = fakeStore();
    configureRemoteAgentOwners(store);
    vi.spyOn(remoteAgentAdmission, "resolveBinding").mockResolvedValue(binding);
    const runner = makeOwnedRemoteAgentProcess({
      getBound: async () => {
        throw new Error("connect failed");
      },
    } as never);

    await expect(
      runner({
        ownerKey: "process:failure",
        target: "ssh:target",
        cwd: "/workspace",
        request: {
          workspaceHandle: "workspace",
          operationId: "operation",
          requestDigest: new Uint8Array([1]),
          command: "printf",
        },
      }),
    ).rejects.toThrow("connect failed");
    expect(rolledBack).toHaveLength(1);
  });

  it("rolls back a newly reserved PTY owner when connection setup fails before dispatch", async () => {
    const { store, rolledBack } = fakeStore();
    vi.spyOn(remoteAgentAdmission, "resolveBinding").mockResolvedValue(binding);
    const pty = makeOwnedRemoteAgentPty(
      {
        getBound: async () => {
          throw new Error("connect failed");
        },
      } as never,
      () => store,
    );

    await expect(
      pty({
        ownerKey: "terminal:failure",
        executionTargetId: "ssh:target",
        remoteCwd: "/workspace",
        shell: "/bin/sh",
        cwd: "/workspace",
        cols: 80,
        rows: 24,
        env: {},
      }),
    ).rejects.toThrow("connect failed");
    expect(rolledBack).toHaveLength(1);
  });

  it("fails concurrent process and PTY callers before a duplicate dispatch", async () => {
    const processStore = fakeStore(preparedOwner("process:concurrent", "01"));
    configureRemoteAgentOwners(processStore.store);
    const processGetBound = vi.fn();
    const processRunner = makeOwnedRemoteAgentProcess({ getBound: processGetBound } as never);
    await expect(
      processRunner({
        ownerKey: "process:concurrent",
        target: "ssh:target",
        cwd: "/workspace",
        request: {
          workspaceHandle: "workspace",
          operationId: "operation",
          requestDigest: new Uint8Array([1]),
          command: "printf",
        },
      }),
    ).rejects.toMatchObject({ code: "PROCESS_IN_PROGRESS" });
    expect(processGetBound).not.toHaveBeenCalled();

    const digest = Buffer.from(
      remoteAgentRequestDigest({ target: "ssh:target", cwd: "/workspace" }),
    ).toString("hex");
    const ptyStore = fakeStore(preparedOwner("terminal:concurrent", digest));
    configureRemoteAgentOwners(ptyStore.store);
    const ptyGetBound = vi.fn();
    const pty = makeOwnedRemoteAgentPty({ getBound: ptyGetBound } as never);
    await expect(
      pty({
        ownerKey: "concurrent",
        executionTargetId: "ssh:target",
        remoteCwd: "/workspace",
        shell: "/bin/sh",
        cwd: "/workspace",
        cols: 80,
        rows: 24,
        env: {},
      }),
    ).rejects.toMatchObject({ code: "PTY_IN_PROGRESS" });
    expect(ptyGetBound).not.toHaveBeenCalled();
  });
});
