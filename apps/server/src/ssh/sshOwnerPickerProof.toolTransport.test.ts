import { beforeAll, expect, it, vi } from "vitest";

vi.mock("./sshProcess.ts", () => ({ runSshCommand: vi.fn() }));

import { runSshCommand } from "./sshProcess.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.client.ts";
import { RemoteTargetDisconnectedError } from "./sshTargetDisconnects.ts";
import { activateDevSshOwner } from "./sshOwnerDevMode.ts";
import {
  runTypedSshToolCommand,
  type TypedSshToolCapability,
  type TypedSshToolOwner,
} from "../tool-transport/toolTransport.ssh.owner.ts";
import {
  runSshToolCommand,
  SelectedSshToolTransportError,
} from "../tool-transport/toolTransport.ssh.ts";
import { runCancellableSshToolCommand } from "../tool-transport/toolTransport.ssh.cancellation.ts";

beforeAll(activateDevSshOwner);

const targetId = "ssh:host=fixture.invalid&transport=direct-ssh";
const workspaceRoot = "/srv/project";

function capability(owner: MockedOwner, signal?: AbortSignal): TypedSshToolCapability {
  return {
    targetId,
    workspaceRoot,
    withOwner: async (id, use, boundSignal) => {
      expect(id).toBe(targetId);
      expect(boundSignal).toBe(signal);
      return use(owner as unknown as TypedSshToolOwner);
    },
  };
}

type MockedOwner = { [K in keyof TypedSshToolOwner]: ReturnType<typeof vi.fn> };

function owner(): MockedOwner {
  return {
    readProofWorkspaceFile: vi.fn(async () => ({
      data: new Uint8Array([0x61, 0x62]),
      sizeBytes: 2,
      truncated: false,
    })),
    listProofWorkspaceDirectory: vi.fn(async () => ({
      entries: [{ name: "nested", directory: true }],
      truncated: false,
    })),
    searchProofWorkspaceContents: vi.fn(async () => ({
      matches: [{ path: "a.txt", line: 1, lineText: "abc" }],
      truncated: false,
    })),
    writeProofWorkspaceFile: vi.fn(async () => undefined),
    createProofWorkspaceDirectory: vi.fn(async () => "created" as const),
    deleteProofWorkspaceEntry: vi.fn(async () => "deleted" as const),
  };
}

it("dispatches each fixed verb through the bound owner", async () => {
  const backend = owner();
  const bound = capability(backend);
  await expect(
    runTypedSshToolCommand({
      capability: bound,
      command: { kind: "file.read", relativePath: "a.txt" },
    }),
  ).resolves.toMatchObject({ kind: "file", sizeBytes: 2 });
  await expect(
    runTypedSshToolCommand({
      capability: bound,
      command: { kind: "file.range", relativePath: "a.txt", offset: 1, maxBytes: 2 },
    }),
  ).resolves.toMatchObject({ kind: "file" });
  await expect(
    runTypedSshToolCommand({
      capability: bound,
      command: { kind: "search.contents", query: "abc", limit: 5 },
    }),
  ).resolves.toMatchObject({ kind: "search" });
  await expect(
    runTypedSshToolCommand({
      capability: bound,
      command: { kind: "directory.list", relativeDir: "" },
    }),
  ).resolves.toMatchObject({ kind: "directory" });
  await expect(
    runTypedSshToolCommand({
      capability: bound,
      command: { kind: "directory.create", relativePath: "new" },
    }),
  ).resolves.toMatchObject({ kind: "created", alreadyExists: false });
  await expect(
    runTypedSshToolCommand({
      capability: bound,
      command: { kind: "entry.delete", relativePath: "old.txt", expectedKind: "file" },
    }),
  ).resolves.toMatchObject({ kind: "deleted" });
  await expect(
    runTypedSshToolCommand({
      capability: bound,
      command: { kind: "file.write", relativePath: "a.txt", contents: "abc" },
    }),
  ).resolves.toMatchObject({ kind: "written" });
  await expect(
    runTypedSshToolCommand({
      capability: bound,
      command: { kind: "file.patch", relativePath: "a.txt", contents: "abc" },
    }),
  ).resolves.toMatchObject({ kind: "written" });
  expect(backend.writeProofWorkspaceFile).toHaveBeenCalledTimes(2);
  expect(runSshCommand).not.toHaveBeenCalled();
});

it("refuses an arbitrary command before any request", async () => {
  expect(() =>
    runSshToolCommand({
      executionTargetId: targetId,
      command: "sh",
      args: ["-lc", "curl example.invalid"],
    }),
  ).toThrow(SelectedSshToolTransportError);
  await expect(
    runCancellableSshToolCommand({
      executionTargetId: targetId,
      command: "sh",
      signal: new AbortController().signal,
    }),
  ).rejects.toBeInstanceOf(SelectedSshToolTransportError);
  expect(runSshCommand).not.toHaveBeenCalled();
});

it("cancels a typed read through its operation lease, not a second SSH launch", async () => {
  const controller = new AbortController();
  const backend = owner();
  backend.readProofWorkspaceFile.mockImplementation(
    async (_input: unknown, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      throw new PickerProofOwnerError("listCancelled");
    },
  );
  await expect(
    runTypedSshToolCommand({
      capability: capability(backend, controller.signal),
      command: { kind: "file.read", relativePath: "a.txt" },
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ code: "listCancelled" });
  expect(backend.readProofWorkspaceFile).toHaveBeenCalledOnce();
  expect(runSshCommand).not.toHaveBeenCalled();
});

it("keeps a disconnected target at zero fallback", async () => {
  const backend = owner();
  const disconnected: TypedSshToolCapability = {
    targetId,
    workspaceRoot,
    withOwner: async () => {
      throw new RemoteTargetDisconnectedError(targetId);
    },
  };
  await expect(
    runTypedSshToolCommand({
      capability: disconnected,
      command: { kind: "file.write", relativePath: "a.txt", contents: "abc" },
    }),
  ).rejects.toBeInstanceOf(RemoteTargetDisconnectedError);
  expect(backend.writeProofWorkspaceFile).not.toHaveBeenCalled();
  expect(runSshCommand).not.toHaveBeenCalled();
});
