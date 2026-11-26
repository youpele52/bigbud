import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import type { AcpSessionRuntimeShape } from "../provider/acp/AcpSessionRuntime.ts";
import { makeFakeShellOwner } from "../ssh/sshOwnerPickerProof.productionShell.fixture.ts";
import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import type { WorkspaceTarget } from "../workspace-target/workspaceTarget.ts";
import { createRemoteWorkspaceAcpBridge } from "./remoteWorkspaceAcpBridge.ts";
import {
  makeProductionAcpWorkspace,
  usesProductionAcpBridge,
} from "./remoteWorkspaceAcpBridge.production.ts";

const targetId = "ssh:host=192.0.2.10&port=22&user=dev&transport=direct-ssh";
const workspaceRoot = "/srv/project";
const workspaceTarget = {
  location: "remote",
  executionTargetId: targetId,
  cwd: workspaceRoot,
} as WorkspaceTarget;

function setup() {
  const shell = makeFakeShellOwner({
    outcome: { exit: 0, output: Buffer.from(`${workspaceRoot}\n`) },
  });
  const data = Buffer.from("hello\n");
  const bound = {
    ...shell.client,
    generation: Uint8Array.of(7),
    probeProofWorkspaceReadiness: vi.fn(),
    readProofWorkspaceFile: vi.fn(async (_: unknown) => ({
      data,
      sizeBytes: data.length,
      truncated: false,
    })),
    writeProofWorkspaceFile: vi.fn(async (_: unknown) => undefined),
    createProofWorkspaceDirectory: vi.fn(),
    deleteProofWorkspaceEntry: vi.fn(),
  };
  const live = {
    handle: { ownerEpoch: Uint8Array.of(1), target: () => bound },
    descriptorFor: async () => ({
      targetId,
      kind: "structured",
      host: "192.0.2.10",
      port: 22,
      user: "dev",
    }),
  } as unknown as SshOwnerProductionRegistration;
  return { shell, bound, owner: () => live };
}

it("selects the production bridge only for direct ssh targets", () => {
  expect(usesProductionAcpBridge(workspaceTarget)).toBe(true);
  expect(usesProductionAcpBridge({ ...workspaceTarget, executionTargetId: "local" })).toBe(false);
});

it("composes owner reads, writes and the approved pwd terminal on the exact target", async () => {
  const { shell, bound, owner } = setup();
  const production = makeProductionAcpWorkspace({ targetId, workspaceRoot, owner });
  const bridge = await createRemoteWorkspaceAcpBridge({
    workspaceTarget,
    ptyResolver: undefined,
    prefix: "bigbud-acp-production-test-",
    readmeLines: [],
    ownerSelected: true,
    sessionFsOwner: production.sessionFsOwner,
    acpTerminal: {
      owner: production.terminalOwner,
      producer: production.producer,
      threadId: "thread-1",
      sessionEpoch: 0,
    },
  });
  const handlers = new Map<string, (request: never) => Effect.Effect<unknown, unknown>>();
  const acp = new Proxy({} as AcpSessionRuntimeShape, {
    get:
      (_target, name: string) => (handler: (request: never) => Effect.Effect<unknown, unknown>) =>
        Effect.sync(() => void handlers.set(name, handler)),
  });
  try {
    expect(bridge.clientCapabilities).toEqual({
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    });
    await Effect.runPromise(bridge.registerHandlers(acp));
    bridge.bindCaller?.("acp-1");
    const call = (name: string, request: unknown) =>
      Effect.runPromise(handlers.get(name)!(request as never));
    const path = `${bridge.cwd}/notes.txt`;
    await expect(call("handleReadTextFile", { sessionId: "acp-1", path })).resolves.toEqual({
      content: "hello\n",
    });
    await expect(
      call("handleWriteTextFile", { sessionId: "acp-1", path, content: "new" }),
    ).resolves.toEqual({});
    expect(bound.writeProofWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({
        executionTargetId: targetId,
        workspaceRoot,
        relativePath: "notes.txt",
      }),
    );
    const { terminalId } = (await call("handleCreateTerminal", {
      sessionId: "acp-1",
      command: "pwd",
    })) as { terminalId: string };
    await expect(
      call("handleTerminalWaitForExit", { sessionId: "acp-1", terminalId }),
    ).resolves.toEqual({ exitCode: 0, signal: null });
    await expect(
      call("handleTerminalOutput", { sessionId: "acp-1", terminalId }),
    ).resolves.toMatchObject({ output: `${workspaceRoot}\n` });
    expect(shell.operations[0]).toMatchObject({
      kind: "runAcpCommand",
      workspaceRoot,
      cwd: workspaceRoot,
    });
    // U21: any other command is an approved ACP shell lease bound to its exact text.
    await expect(
      call("handleCreateTerminal", { sessionId: "acp-1", command: "sh", args: ["-c", "id"] }),
    ).resolves.toMatchObject({ terminalId: expect.any(String) });
    expect(shell.operations.find((operation) => operation.kind === "runAcpShell")).toMatchObject({
      command: "sh '-c' 'id'",
      workspaceRoot,
      cwd: workspaceRoot,
    });
    // An environment is still never forwarded: refused before an owner lease opens.
    await expect(
      call("handleCreateTerminal", {
        sessionId: "acp-1",
        command: "id",
        env: [{ name: "X", value: "1" }],
      }),
    ).rejects.toThrow();
    expect(
      shell.operations.filter((operation) => operation.kind.startsWith("runAcp")),
    ).toHaveLength(2);
  } finally {
    await bridge.cleanup();
  }
});
