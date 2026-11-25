import { Effect } from "effect";
import { beforeAll, expect, it, vi } from "vitest";

import {
  prepareAcpRemoteWorkspaceSession,
  resolveAcpSessionFsOwner,
} from "../provider/Layers/AcpRemoteWorkspace.session.ts";
import type { AcpSessionRuntimeShape } from "../provider/acp/AcpSessionRuntime.ts";
import { activateDevSshOwner } from "../ssh/sshOwnerDevMode.fixture.ts";
import { DevSshOwnerRuntime } from "../ssh/sshOwnerDevRuntime.ts";
import type { SessionFsOwnerWorkspace } from "./remoteWorkspaceSessionFsBridge.owner.ts";

const targetId = "ssh:host=fixture.invalid&transport=direct-ssh";
const workspaceRoot = "/srv/project";
const startInput = {
  threadId: "thread-owner-test",
  cwd: workspaceRoot,
  workspaceExecutionTargetId: targetId,
} as Parameters<typeof prepareAcpRemoteWorkspaceSession>[0]["sessionInput"];

beforeAll(activateDevSshOwner);

function fixture() {
  let generation = "initial";
  const data = Buffer.from("﻿α\r\nsecond\r\nlast\n", "utf8");
  const readProofWorkspaceFile = vi.fn(async (_: unknown) => ({
    data,
    sizeBytes: data.length,
    truncated: false,
  }));
  const owner = {
    ownerEpoch: Uint8Array.of(1),
    get trackedGitTargetGeneration() {
      return generation;
    },
    probeProofWorkspaceReadiness: vi.fn(async () => ({
      os: "linux" as const,
      architecture: "x86_64" as const,
    })),
    readProofWorkspaceFile,
    writeProofWorkspaceFile: vi.fn(async () => undefined),
    createProofWorkspaceDirectory: vi.fn(async () => "created" as const),
    deleteProofWorkspaceEntry: vi.fn(async () => "deleted" as const),
  };
  const withOwner: SessionFsOwnerWorkspace["withOwner"] = async (id, use) => {
    expect(id).toBe(targetId);
    return use(owner);
  };
  const session = {
    kind: "unix",
    targetId,
    fixture: { folder: workspaceRoot },
    picker: { withOwner },
  } as NonNullable<(typeof DevSshOwnerRuntime.Service)["session"]>;
  const readinessProbe = vi.fn(async () => {
    throw new Error("legacy readiness must not run");
  });
  const orchestrationCleanup = vi.fn(async () => {});
  return {
    data,
    readProofWorkspaceFile,
    changeGeneration: () => {
      generation = "replacement";
    },
    readinessProbe,
    orchestrationCleanup,
    prepare: async (cwd = workspaceRoot, executionTarget = targetId, provideOwner = true) => {
      const sessionFsOwner = await Effect.runPromise(
        resolveAcpSessionFsOwner().pipe(
          Effect.provideService(DevSshOwnerRuntime, {
            session: provideOwner ? session : undefined,
          }),
        ),
      );
      return Effect.runPromise(
        prepareAcpRemoteWorkspaceSession({
          provider: "cursor",
          sessionInput: { ...startInput, cwd, workspaceExecutionTargetId: executionTarget },
          ptyResolver: undefined,
          orchestrationCleanup,
          readinessProbe,
          ...(sessionFsOwner ? { sessionFsOwner } : {}),
        }),
      );
    },
  };
}

it("composes the selected owner into ACP callbacks and preserves bounded text", async () => {
  const setup = fixture();
  const prepared = await setup.prepare();
  const bridge = prepared.remoteBridge!;
  const handlers = {
    handleReadTextFile: vi.fn<
      Pick<AcpSessionRuntimeShape, "handleReadTextFile">["handleReadTextFile"]
    >(() => Effect.void),
    handleWriteTextFile: vi.fn<
      Pick<AcpSessionRuntimeShape, "handleWriteTextFile">["handleWriteTextFile"]
    >(() => Effect.void),
    handleCreateTerminal: vi.fn<
      Pick<AcpSessionRuntimeShape, "handleCreateTerminal">["handleCreateTerminal"]
    >(() => Effect.void),
  };
  try {
    expect(bridge.clientCapabilities).toEqual({
      fs: { readTextFile: true, writeTextFile: false },
      terminal: false,
    });
    await Effect.runPromise(bridge.registerHandlers(handlers as unknown as AcpSessionRuntimeShape));
    const [read] = handlers.handleReadTextFile.mock.calls[0]!;
    const [write] = handlers.handleWriteTextFile.mock.calls[0]!;
    const [terminal] = handlers.handleCreateTerminal.mock.calls[0]!;
    const request = { sessionId: "live", path: `${bridge.cwd}/file.txt` };
    await expect(Effect.runPromise(read(request))).rejects.toThrow();
    bridge.bindCaller?.("live");
    await expect(Effect.runPromise(read({ ...request, sessionId: "other" }))).rejects.toThrow();
    for (const path of ["../outside", "/srv/project-other/file", ".bigbud/session-state/file"]) {
      await expect(Effect.runPromise(read({ ...request, path }))).rejects.toThrow();
    }
    await expect(Effect.runPromise(write({ ...request, content: "denied" }))).rejects.toThrow();
    await expect(
      Effect.runPromise(terminal({ sessionId: "live", command: "pwd" })),
    ).rejects.toThrow();
    expect(setup.readProofWorkspaceFile).not.toHaveBeenCalled();
    await expect(Effect.runPromise(read(request))).resolves.toEqual({
      content: setup.data.toString("utf8"),
    });
    expect(setup.readProofWorkspaceFile).toHaveBeenCalledExactlyOnceWith({
      executionTargetId: targetId,
      workspaceRoot,
      relativePath: "file.txt",
      kind: "range",
      offset: 0,
      maxBytes: 512 * 1024,
    });
    await expect(Effect.runPromise(read({ ...request, line: 2, limit: 1 }))).resolves.toEqual({
      content: "second\r",
    });
    setup.readProofWorkspaceFile.mockResolvedValueOnce({
      data: setup.data,
      sizeBytes: setup.data.length + 1,
      truncated: true,
    });
    await expect(Effect.runPromise(read(request))).rejects.toThrow();
    setup.readProofWorkspaceFile.mockResolvedValueOnce({
      data: Buffer.from([0xc0]),
      sizeBytes: 1,
      truncated: false,
    });
    await expect(Effect.runPromise(read(request))).rejects.toThrow();
    setup.readProofWorkspaceFile.mockRejectedValueOnce(new Error("owner refused"));
    await expect(Effect.runPromise(read(request))).rejects.toThrow("owner refused");
    setup.readProofWorkspaceFile.mockImplementationOnce(async () => {
      setup.changeGeneration();
      return { data: setup.data, sizeBytes: setup.data.length, truncated: false };
    });
    await expect(Effect.runPromise(read(request))).rejects.toThrow();
    await expect(Effect.runPromise(read(request))).rejects.toThrow();
    expect(setup.readProofWorkspaceFile).toHaveBeenCalledTimes(6);
    expect(setup.readinessProbe).not.toHaveBeenCalled();
    await bridge.cleanup();
    await expect(Effect.runPromise(read(request))).rejects.toThrow();
  } finally {
    await prepared.cleanup();
  }
});

it("rejects mismatched roots and targets before asking the owner to read", async () => {
  const setup = fixture();
  await expect(setup.prepare(`${workspaceRoot}/subdir`)).rejects.toThrow();
  await expect(
    setup.prepare(workspaceRoot, "ssh:host=elsewhere.invalid&transport=direct-ssh"),
  ).rejects.toThrow();
  expect(setup.readProofWorkspaceFile).not.toHaveBeenCalled();
  expect(setup.readinessProbe).not.toHaveBeenCalled();
  await expect(setup.prepare(workspaceRoot, targetId, false)).rejects.toThrow();
  expect(setup.orchestrationCleanup).toHaveBeenCalledTimes(3);
});
