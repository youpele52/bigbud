import { PassThrough } from "node:stream";

import { ApprovalRequestId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { expect, it, vi } from "vitest";

import { makeAcpTerminalCommandProofOwner } from "./remoteWorkspaceAcpTerminal.owner.proof.ts";
import {
  issueAcpTerminalCommandApproval,
  type AcpOwnerCommand,
  type SelectedAcpTerminalOwner,
} from "./remoteWorkspaceAcpTerminal.owner.ts";
import { createRemoteWorkspaceAcpTerminal } from "./remoteWorkspaceAcpTerminal.ts";

const targetId = "ssh:host=example&transport=direct-ssh";
const workspaceRoot = "/work/project";
const cwd = "/work/project/sub dir";
const identity = {
  requestId: ApprovalRequestId.makeUnsafe("approval-acp-command"),
  threadId: ThreadId.makeUnsafe("thread-acp-command"),
  sessionEpoch: 1,
  acpSessionId: "acp-session-command",
  toolCallId: "tool-call-command",
};
const command: AcpOwnerCommand = {
  executionTargetId: targetId,
  workspaceRoot,
  cwd,
  approval: identity,
  operation: "print-working-directory",
};

function owner(output = `${cwd}\n`, truncated = false) {
  const calls: unknown[] = [];
  const withOwner = vi.fn(async (_targetId: string, use: (client: unknown) => Promise<unknown>) =>
    use({
      runProofAcpCommand: async (input: { workspaceRoot: string; cwd: string }) => {
        calls.push(input);
        return { output, exitCode: 0, truncated };
      },
    }),
  );
  return {
    calls,
    owner: makeAcpTerminalCommandProofOwner({
      targetId,
      workspaceRoot,
      withOwner: withOwner as never,
    }),
  };
}

it("runs the owner-selected fixed recipe with output and a confirmed exit", async () => {
  const proof = owner();
  const lease = await proof.owner.runAcpCommand(command, new AbortController().signal);
  const chunks: Buffer[] = [];
  for await (const chunk of lease.output) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString("utf8")).toBe(`${cwd}\n`);
  await expect(lease.exit).resolves.toEqual({ kind: "exited", code: 0 });
  expect(proof.calls).toEqual([{ workspaceRoot, cwd }]);
});

it("refuses a truncated or mismatched fixed-recipe result", async () => {
  await expect(
    owner("wrong\n").owner.runAcpCommand(command, new AbortController().signal),
  ).rejects.toMatchObject({ code: "unsupported-cwd" });
  await expect(
    owner(`${cwd}\n`, true).owner.runAcpCommand(command, new AbortController().signal),
  ).rejects.toMatchObject({ code: "unsupported-cwd" });
});

it("cancels acquisition before the fixed recipe runs and never replays it", async () => {
  const proof = owner();
  const controller = new AbortController();
  controller.abort();
  await expect(proof.owner.runAcpCommand(command, controller.signal)).rejects.toThrow();
  expect(proof.calls).toEqual([]);
});

it("ignores stdin and refuses interactive conversion or agent-mode terminals", async () => {
  const output = new PassThrough();
  output.end(`${cwd}\n`);
  const runAcpCommand = vi.fn(async () => ({
    output,
    exit: Promise.resolve({ kind: "exited" as const, code: 0 }),
    cancel: async () => undefined,
  }));
  const selection: SelectedAcpTerminalOwner = {
    kind: "selected",
    identity,
    approval: issueAcpTerminalCommandApproval({ ...command, decision: "accept" }),
    signal: new AbortController().signal,
    owner: { runAcpCommand },
  };
  const base = {
    executionTargetId: targetId,
    workspaceRoot,
    cwd,
    command: "pwd",
    args: [],
    ptyResolver: undefined,
  };
  const terminal = await createRemoteWorkspaceAcpTerminal({
    ...base,
    sshOwner: selection,
  });
  // The consumed approval also carries its (here unbounded) expiry and empty generation.
  expect(runAcpCommand).toHaveBeenCalledExactlyOnceWith(
    { ...command, expiresAt: Number.POSITIVE_INFINITY, generation: "" },
    selection.signal,
  );
  output.resume();
  await terminal.close();

  const fresh = () => issueAcpTerminalCommandApproval({ ...command, decision: "accept" });
  for (const [label, overrides] of [
    ["interactive shell", { command: "sh" }],
    ["interactive args", { args: ["-i"] }],
    ["environment", { environment: [{ name: "PATH", value: "/tmp" }] }],
    ["agent target", { executionTargetId: "ssh:host=example&transport=agent" }],
  ] as const) {
    await expect(
      createRemoteWorkspaceAcpTerminal({
        ...base,
        ...overrides,
        sshOwner: {
          ...selection,
          approval: fresh(),
        },
      }),
      label,
    ).rejects.toMatchObject({
      code: label === "agent target" ? "unsupported-target" : "unsupported-command",
    });
  }
  expect(runAcpCommand).toHaveBeenCalledTimes(1);
});

it("does not allow the ACP command authority to run a thread or provider shell", () => {
  const proof = owner();
  // The proof port exposes only the fixed ACP command; there is no generic
  // shell method and no way to pass caller program/args/stdin/PTY options.
  expect(Object.keys(proof.owner)).toEqual(["runAcpCommand"]);
});
