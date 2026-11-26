import { text } from "node:stream/consumers";

import { ApprovalRequestId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { expect, it, vi } from "vitest";

import { makePickerProofTerminalClient } from "../ssh/sshOwnerPickerProof.client.terminal.ts";
import type { Outcome } from "../ssh/sshOwnerPickerProof.codec.outcome.ts";
import { PickerProofOwnerError } from "../ssh/sshOwnerPickerProof.codec.wire.ts";
import { makeAcpTerminalCwdProofObserver } from "./remoteWorkspaceAcpTerminal.owner.proof.ts";
import type { AcpOwnerCommand } from "./remoteWorkspaceAcpTerminal.owner.ts";

const targetId = "ssh:host=fixture&transport=direct-ssh";
const workspaceRoot = "/work/project";
const cwd = `${workspaceRoot}/reports ☃`;
const approved = {
  executionTargetId: targetId,
  workspaceRoot,
  cwd,
  operation: "print-working-directory",
  approval: {
    requestId: ApprovalRequestId.makeUnsafe("proof-request"),
    threadId: ThreadId.makeUnsafe("proof-thread"),
    sessionEpoch: 2,
    acpSessionId: "proof-session",
    toolCallId: "proof-call",
  },
} satisfies AcpOwnerCommand;

function fixture(beforeAdmission?: Promise<void>) {
  const execute = vi.fn<Parameters<typeof makePickerProofTerminalClient>[0]>();
  execute.mockImplementation(async (operation) => {
    if (operation.kind !== "proofTerminalCwd") throw new Error("Unexpected native operation");
    return { kind: "proofTerminalCwd", value: operation.cwd };
  });
  const copyBinding = vi.fn(() => {
    throw new Error("An observation does not acquire a terminal lease");
  });
  const owner = makePickerProofTerminalClient(execute, copyBinding);
  const admissions = vi.fn<(target: string) => void>();
  const observer = makeAcpTerminalCwdProofObserver({
    targetId,
    workspaceRoot,
    async withOwner(target, use) {
      admissions(target);
      await beforeAdmission;
      return use(owner);
    },
  });
  return { observer, execute, admissions, copyBinding };
}

it("uses only the typed cwd observation and returns independent finite output per request", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  const first = await f.observer.observeAcpCwd(approved, signal);
  const second = await f.observer.observeAcpCwd(
    {
      ...approved,
      cwd: workspaceRoot,
      approval: { ...approved.approval, requestId: ApprovalRequestId.makeUnsafe("another") },
    },
    signal,
  );
  expect(first.kind).toBe("cwd-observation");
  expect(Object.keys(first).toSorted()).toEqual(["kind", "output"]);
  expect(first.output).not.toBe(second.output);
  expect(f.admissions.mock.calls).toEqual([[targetId], [targetId]]);
  expect(f.execute.mock.calls).toEqual([
    [{ kind: "proofTerminalCwd", cwd }],
    [{ kind: "proofTerminalCwd", cwd: workspaceRoot }],
  ]);
  // Local release of one result cannot cancel or discard another.
  second.output.destroy();
  await expect(text(first.output)).resolves.toBe(`${cwd}\n`);
  expect(f.copyBinding).not.toHaveBeenCalled();
});

it.each([
  [{ executionTargetId: "ssh:host=other&transport=direct-ssh" }, "unsupported-target"],
  [{ workspaceRoot: "/work" }, "unsupported-cwd"],
  [{ cwd: `${workspaceRoot}-sibling` }, "unsupported-cwd"],
  [{ cwd: `${workspaceRoot}/../project` }, "unsupported-cwd"],
  [{ cwd: `${workspaceRoot}/` }, "unsupported-cwd"],
  [{ cwd: `${workspaceRoot}/\0` }, "unsupported-cwd"],
  [{ cwd: `${workspaceRoot}/${"é".repeat(2048)}` }, "unsupported-cwd"],
] as const)(
  "rejects changed or invalid operands %j before owner admission",
  async (change, code) => {
    const f = fixture();
    await expect(
      f.observer.observeAcpCwd({ ...approved, ...change }, new AbortController().signal),
    ).rejects.toMatchObject({ code });
    expect(f.admissions).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  },
);

it("refuses a different physical cwd, wrong typed reply, or native refusal without retry", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  f.execute.mockResolvedValueOnce({ kind: "proofTerminalCwd", value: workspaceRoot });
  await expect(f.observer.observeAcpCwd(approved, signal)).rejects.toMatchObject({
    code: "unsupported-cwd",
  });
  f.execute.mockResolvedValueOnce({ kind: "proofHealth", value: true });
  await expect(f.observer.observeAcpCwd(approved, signal)).rejects.toMatchObject({
    code: "protocolError",
  });
  const error = new PickerProofOwnerError("targetDisconnected");
  f.execute.mockRejectedValueOnce(error);
  await expect(f.observer.observeAcpCwd(approved, signal)).rejects.toBe(error);
  expect(f.execute).toHaveBeenCalledTimes(3);
});

it("checks cancellation before admission, inside the queue, and after native completion", async () => {
  const queued = Promise.withResolvers<void>();
  const f = fixture(queued.promise);
  const reason = new Error("approval is no longer active");
  const early = AbortSignal.abort(reason);
  await expect(f.observer.observeAcpCwd(approved, early)).rejects.toBe(reason);
  expect(f.admissions).not.toHaveBeenCalled();

  const waiting = new AbortController();
  const waitingResult = f.observer.observeAcpCwd(approved, waiting.signal);
  waiting.abort(reason);
  queued.resolve();
  await expect(waitingResult).rejects.toBe(reason);
  expect(f.execute).not.toHaveBeenCalled();

  const pending = new AbortController();
  const reply = Promise.withResolvers<Outcome>();
  f.execute.mockReturnValueOnce(reply.promise);
  const pendingResult = f.observer.observeAcpCwd(approved, pending.signal);
  await Promise.resolve();
  expect(f.execute).toHaveBeenCalledExactlyOnceWith({ kind: "proofTerminalCwd", cwd });
  pending.abort(reason);
  reply.resolve({ kind: "proofTerminalCwd", value: cwd });
  await expect(pendingResult).rejects.toBe(reason);
  await expect(
    text((await f.observer.observeAcpCwd(approved, new AbortController().signal)).output),
  ).resolves.toBe(`${cwd}\n`);
});
