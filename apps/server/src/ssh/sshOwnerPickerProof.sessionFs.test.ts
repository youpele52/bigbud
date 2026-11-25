import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeAll, expect, it, vi } from "vitest";

vi.mock("../tool-transport/toolTransport.ts", async (load) => ({
  ...(await load<typeof import("../tool-transport/toolTransport.ts")>()),
  runToolCommand: vi.fn(async () => {
    throw new Error("Unexpected generic tool transport");
  }),
}));

import { activateDevSshOwner } from "../ssh/sshOwnerDevMode.ts";
import { runToolCommand } from "../tool-transport/toolTransport.ts";
import { resolveWorkspaceTarget } from "../workspace-target/workspaceTarget.ts";
import { createRemoteWorkspaceSessionFsBridge } from "../remote-workspace-bridge/remoteWorkspaceSessionFsBridge.ts";
import {
  makeSelectedOwnerReadinessProbe,
  SelectedSshOwnerWorkspaceBridgeError,
} from "../remote-workspace-bridge/remoteWorkspaceReadiness.ts";
import {
  createSelectedSessionFsProvider,
  type SessionFsOwnerCapability,
} from "../remote-workspace-bridge/remoteWorkspaceSessionFsBridge.ownerProvider.ts";

beforeAll(activateDevSshOwner);

const targetId = "ssh:host=fixture.invalid&transport=direct-ssh";
const workspaceRoot = "/srv/project";

function capability(owner: Record<string, ReturnType<typeof vi.fn>>): SessionFsOwnerCapability {
  return {
    targetId,
    workspaceRoot,
    withOwner: async (id, use) => {
      expect(id).toBe(targetId);
      return use(owner as never);
    },
  };
}

it("reads and writes through typed owner verbs with a bound capability", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "bigbud-owner-session-fs-"));
  try {
    const owner = {
      probeProofWorkspaceReadiness: vi.fn(async () => ({
        os: "linux" as const,
        architecture: "x86_64" as const,
      })),
      readProofWorkspaceFile: vi.fn(async () => ({
        data: new TextEncoder().encode("hello"),
        sizeBytes: 5,
        truncated: false,
      })),
      writeProofWorkspaceFile: vi.fn(async () => undefined),
      createProofWorkspaceDirectory: vi.fn(async () => "created" as const),
      deleteProofWorkspaceEntry: vi.fn(async () => "deleted" as const),
    };
    const provider = createSelectedSessionFsProvider({
      capability: capability(owner),
      initialCwd: workspaceRoot,
      bridgeCwd: path.join(stateRoot, "bridge"),
      stateRoot,
    });
    await expect(provider.readFile("src/index.ts")).resolves.toBe("hello");
    await provider.writeFile("src/index.ts", "next");
    await expect(provider.appendFile("src/index.ts", "x")).rejects.toBeInstanceOf(
      SelectedSshOwnerWorkspaceBridgeError,
    );
    expect(owner.readProofWorkspaceFile).toHaveBeenCalledWith({
      executionTargetId: targetId,
      workspaceRoot,
      relativePath: "src/index.ts",
      kind: "range",
      offset: 0,
      maxBytes: 512 * 1024,
    });
    expect(owner.writeProofWorkspaceFile).toHaveBeenCalledWith({
      executionTargetId: targetId,
      workspaceRoot,
      relativePath: "src/index.ts",
      contents: new TextEncoder().encode("next"),
    });
    expect(runToolCommand).not.toHaveBeenCalled();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

it("keeps the typed unsupported refusal without a bound capability", async () => {
  const target = resolveWorkspaceTarget({ executionTargetId: targetId, cwd: workspaceRoot });
  await expect(
    createRemoteWorkspaceSessionFsBridge(target, "bigbud-owner-session-fs-", ["fixture"]),
  ).rejects.toMatchObject({
    name: SelectedSshOwnerWorkspaceBridgeError.name,
    operation: "session-filesystem",
  });
  expect(runToolCommand).not.toHaveBeenCalled();
});

it("uses the typed native readiness verb, never a shell probe", async () => {
  const owner = {
    probeProofWorkspaceReadiness: vi.fn(async () => ({
      os: "darwin" as const,
      architecture: "arm64" as const,
    })),
  };
  const probe = makeSelectedOwnerReadinessProbe({
    targetId,
    workspaceRoot,
    withOwner: async (_id, use) => use(owner as never),
  });
  await expect(
    probe(resolveWorkspaceTarget({ executionTargetId: targetId, cwd: workspaceRoot })),
  ).resolves.toEqual({ os: "darwin", architecture: "arm64" });
  await expect(
    probe(resolveWorkspaceTarget({ executionTargetId: targetId, cwd: `${workspaceRoot}/nested` })),
  ).rejects.toBeInstanceOf(SelectedSshOwnerWorkspaceBridgeError);
  expect(runToolCommand).not.toHaveBeenCalled();
});
