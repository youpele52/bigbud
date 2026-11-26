import { ApprovalRequestId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { expect, it } from "vitest";

import {
  makeFakeShellOwner,
  type FakeShellOutcome,
} from "../ssh/sshOwnerPickerProof.productionShell.fixture.ts";
import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import { makeProductionAcpTerminalOwner } from "./remoteWorkspaceAcpTerminal.owner.production.ts";
import type { AcpOwnerCommand } from "./remoteWorkspaceAcpTerminal.owner.ts";

const TARGET = "ssh:host=devbox&transport=direct-ssh";

function setup(outcome: FakeShellOutcome, pollsBeforeExit = 1) {
  const owner = makeFakeShellOwner({ outcome, pollsBeforeExit });
  const live = {
    handle: { target: () => owner.client },
    descriptorFor: async (targetId: string) => ({ targetId }) as never,
  } as unknown as SshOwnerProductionRegistration;
  return {
    owner,
    port: makeProductionAcpTerminalOwner({
      targetId: TARGET,
      workspaceRoot: "/srv/work",
      owner: () => live,
    }),
  };
}

const command = (cwd: string): AcpOwnerCommand => ({
  approval: {
    requestId: ApprovalRequestId.makeUnsafe("r"),
    threadId: ThreadId.makeUnsafe("t"),
    sessionEpoch: 0,
    acpSessionId: "s",
    toolCallId: "c",
  },
  executionTargetId: TARGET,
  workspaceRoot: "/srv/work",
  cwd,
  operation: "print-working-directory",
});

async function text(stream: NodeJS.ReadableStream): Promise<string> {
  let value = "";
  for await (const chunk of stream) value += chunk.toString();
  return value;
}

it("runs the approved recipe as an ACP lease and settles output and exit", async () => {
  const { owner, port } = setup({ exit: 0, output: Buffer.from("/srv/work/sub\n") });
  const lease = await port.runAcpCommand(command("/srv/work/sub"), new AbortController().signal);
  expect(await text(lease.output)).toBe("/srv/work/sub\n");
  expect(await lease.exit).toEqual({ kind: "exited", code: 0 });
  expect(owner.operations[0]).toMatchObject({
    kind: "runAcpCommand",
    workspaceRoot: "/srv/work",
    cwd: "/srv/work/sub",
  });
  expect(owner.operations.some((operation) => "stdin" in operation)).toBe(false);
});

it("cancel kills only this lease and reports a confirmed SIGKILL exit", async () => {
  const { owner, port } = setup({ exit: 0, output: Buffer.from("/srv/work\n") }, 10_000);
  const lease = await port.runAcpCommand(command("/srv/work"), new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await lease.cancel();
  expect(await lease.exit).toEqual({ kind: "signaled", signal: "SIGKILL" });
  expect(owner.operations.at(-1)).toMatchObject({ kind: "shellClose", role: "acp" });
  expect(owner.leases.size).toBe(0);
});

it("refuses a cwd outside the workspace and a mismatched owner observation", async () => {
  const { owner, port } = setup({ exit: 0, output: Buffer.from("/elsewhere\n") });
  await expect(
    port.runAcpCommand(command("/srv/workshop"), new AbortController().signal),
  ).rejects.toMatchObject({ code: "unsupported-cwd" });
  expect(owner.operations).toHaveLength(0);
  const lease = await port.runAcpCommand(command("/srv/work"), new AbortController().signal);
  lease.output.on("error", () => undefined);
  await expect(lease.exit).rejects.toMatchObject({ code: "unsupported-cwd" });
});

it("U21: an approved non-pwd command runs as its own ACP shell lease with exact text", async () => {
  const { makeAcpTerminalApprovalProducer } = await import("./remoteWorkspaceAcpApproval.ts");
  const { createOwnedAcpTerminal } = await import("./remoteWorkspaceAcpTerminal.owner.ts");
  const { owner, port } = setup({ exit: 2, output: Buffer.from("listing\n") });
  const producer = makeAcpTerminalApprovalProducer({
    targetId: TARGET,
    workspaceRoot: "/srv/work",
    generation: () => "g1",
  });
  const run = async (
    command: string,
    args: string[],
    env: Array<{ name: string; value: string }> = [],
  ) => {
    const issued = producer.issue({
      requestId: ApprovalRequestId.makeUnsafe("r"),
      threadId: ThreadId.makeUnsafe("t"),
      sessionEpoch: 0,
      acpSessionId: "s",
      cwd: "/srv/work",
      command: [command, ...args.map((arg) => `'${arg}'`)].join(" "),
    });
    return createOwnedAcpTerminal(
      {
        executionTargetId: TARGET,
        workspaceRoot: "/srv/work",
        cwd: "/srv/work",
        command,
        args,
        environment: env,
      },
      {
        kind: "selected",
        owner: port,
        identity: issued.identity,
        approval: issued.approval,
        generation: "g1",
        signal: new AbortController().signal,
      },
    );
  };
  const terminal = await run("ls", ["-la"]);
  let output = "";
  terminal.onData((data) => {
    output += data;
  });
  const exit = await new Promise((resolve) => terminal.onExit(resolve));
  expect(exit).toEqual({ exitCode: 2, signal: null });
  expect(output).toBe("listing\n");
  expect(owner.operations[0]).toMatchObject({
    kind: "runAcpShell",
    workspaceRoot: "/srv/work",
    cwd: "/srv/work",
    command: "ls '-la'",
    sessionId: "s",
    timeoutMs: 120_000,
  });
  // An environment is never forwarded: refused before any lease opens.
  await expect(run("ls", [], [{ name: "X", value: "1" }])).rejects.toMatchObject({
    code: "unsupported-command",
  });
  expect(owner.operations.filter((operation) => operation.kind === "runAcpShell")).toHaveLength(1);
});
