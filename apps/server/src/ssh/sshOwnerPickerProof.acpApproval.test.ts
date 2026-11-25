import { Readable } from "node:stream";

import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { describe, expect, it, vi } from "vitest";

import {
  AcpTerminalOwnerError,
  createOwnedAcpTerminal,
  issueAcpTerminalCommandApproval,
  type AcpOwnerCommand,
  type AcpTerminalSshOwner,
} from "../remote-workspace-bridge/remoteWorkspaceAcpTerminal.owner.ts";
import {
  ACP_APPROVAL_TTL_MS,
  makeAcpTerminalApprovalProducer,
} from "../remote-workspace-bridge/remoteWorkspaceAcpApproval.ts";

const targetId = "ssh:host=fixture&auth=ssh-key&transport=direct-ssh";
const workspaceRoot = "/tmp/bigbud-workspace";
const cwd = `${workspaceRoot}/src`;
const identity = {
  requestId: "approval-1" as never,
  threadId: ThreadId.makeUnsafe("thread-acp"),
  sessionEpoch: 2,
  acpSessionId: "acp-session",
};

function owner(): AcpTerminalSshOwner {
  return {
    runAcpCommand: vi.fn(async () => ({
      output: Readable.from([Buffer.from("")]),
      exit: Promise.resolve({ kind: "exited" as const, code: 0 }),
      cancel: async () => undefined,
    })),
  };
}

function input(overrides: Partial<Parameters<typeof createOwnedAcpTerminal>[0]> = {}) {
  return {
    executionTargetId: targetId,
    workspaceRoot,
    cwd,
    command: "pwd",
    ...overrides,
  };
}

describe("approved direct ACP terminal producer", () => {
  it("binds workspace, cwd, the fixed program and args to one approval", async () => {
    let generation = "gen-1";
    const producer = makeAcpTerminalApprovalProducer({
      targetId,
      workspaceRoot,
      generation: () => generation,
    });
    const issued = producer.issue({ ...identity, cwd });
    const port = owner();
    const process = await createOwnedAcpTerminal(input(), {
      kind: "selected",
      owner: port,
      identity: issued.identity,
      approval: issued.approval,
      generation,
      signal: new AbortController().signal,
    });
    await process.close(false);
    expect(port.runAcpCommand).toHaveBeenCalledOnce();
    const approved = vi.mocked(port.runAcpCommand).mock.calls[0]![0];
    expect(approved).toMatchObject({
      executionTargetId: targetId,
      workspaceRoot,
      cwd,
      operation: "print-working-directory",
    });
    generation = "gen-2";
  });

  it("is single use, expires and refuses a stale generation", async () => {
    const now = 1_000;
    let generation = "gen-1";
    const producer = makeAcpTerminalApprovalProducer({
      targetId,
      workspaceRoot,
      generation: () => generation,
      now: () => now,
    });
    const issued = producer.issue({ ...identity, cwd });
    const port = owner();
    const selection = {
      kind: "selected" as const,
      owner: port,
      identity: issued.identity,
      approval: issued.approval,
      generation,
      now,
      signal: new AbortController().signal,
    };
    await createOwnedAcpTerminal(input(), selection);
    await expect(createOwnedAcpTerminal(input(), selection)).rejects.toMatchObject({
      code: "approval-required",
    });

    const expired = producer.issue({ ...identity, cwd });
    await expect(
      createOwnedAcpTerminal(input(), {
        ...selection,
        identity: expired.identity,
        approval: expired.approval,
        now: now + ACP_APPROVAL_TTL_MS,
      }),
    ).rejects.toMatchObject({ code: "approval-required" });

    const stale = producer.issue({ ...identity, cwd });
    generation = "gen-2";
    await expect(
      createOwnedAcpTerminal(input(), {
        ...selection,
        identity: stale.identity,
        approval: stale.approval,
        generation: "gen-2",
      }),
    ).rejects.toMatchObject({ code: "approval-required" });
  });

  it("refuses an approval for another cwd, program or workspace", async () => {
    const producer = makeAcpTerminalApprovalProducer({
      targetId,
      workspaceRoot,
      generation: () => "gen-1",
    });
    for (const overrides of [
      { cwd: `${workspaceRoot}/other` },
      { command: "bash" },
      { executionTargetId: "ssh:host=other&transport=direct-ssh" },
      { workspaceRoot: "/tmp/other" },
    ]) {
      const issued = producer.issue({ ...identity, cwd });
      await expect(
        createOwnedAcpTerminal(input(overrides), {
          kind: "selected",
          owner: owner(),
          identity: issued.identity,
          approval: issued.approval,
          generation: "gen-1",
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(AcpTerminalOwnerError);
    }
  });

  it("requires a composed producer before any approval can exist", () => {
    const command: AcpOwnerCommand = {
      approval: { ...identity, toolCallId: "tool-1" },
      executionTargetId: targetId,
      workspaceRoot,
      cwd,
      operation: "print-working-directory",
      expiresAt: Number.POSITIVE_INFINITY,
      generation: "",
    };
    // The proof helper may issue without a fence; a selected selection with a
    // generation refuses it, so an uncomposed producer cannot reach the owner.
    const receipt = issueAcpTerminalCommandApproval({ ...command, decision: "accept" });
    void receipt;
  });
});
