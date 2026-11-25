import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { ApprovalRequestId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  issueAcpTerminalCommandApproval,
  type AcpOwnerCommand,
  type AcpOwnerExit,
  type SelectedAcpTerminalOwner,
} from "./remoteWorkspaceAcpTerminal.owner.ts";
import { isDevSshOwnerSelected } from "../ssh/sshOwnerDevMode.ts";
import { createRemoteWorkspaceAcpTerminal } from "./remoteWorkspaceAcpTerminal.ts";

vi.mock("../ssh/sshOwnerDevMode.ts", () => ({ isDevSshOwnerSelected: vi.fn() }));

const { launchSsh, createAgentPty, spawn } = vi.hoisted(() => ({
  launchSsh: vi.fn(),
  createAgentPty: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn }));
vi.mock("../ssh/sshCommand.ts", () => ({ buildSshCommandInvocation: launchSsh }));
vi.mock("../remote-agent/remoteAgentPtyAdapter.ts", () => ({
  createRemoteAgentWorkspacePty: createAgentPty,
}));

const identity = {
  requestId: ApprovalRequestId.makeUnsafe("approval-1"),
  threadId: ThreadId.makeUnsafe("thread-1"),
  sessionEpoch: 3,
  acpSessionId: "acp-session-1",
  toolCallId: "tool-call-1",
};
const request = {
  executionTargetId: "ssh:host=example&transport=direct-ssh",
  workspaceRoot: "/work/project",
  cwd: "/work/project/sub dir",
  command: "pwd",
  ptyResolver: undefined,
};
const command: AcpOwnerCommand = {
  executionTargetId: request.executionTargetId,
  workspaceRoot: request.workspaceRoot,
  cwd: request.cwd,
  approval: identity,
  operation: "print-working-directory",
  expiresAt: Number.POSITIVE_INFINITY,
  generation: "",
};

type TerminalInput = Parameters<typeof createRemoteWorkspaceAcpTerminal>[0];
const ptyResolver: NonNullable<TerminalInput["ptyResolver"]> = {
  resolvePty: vi.fn(),
  resolveWorkspace: vi.fn(),
};
const open = (sshOwner: SelectedAcpTerminalOwner, overrides?: Partial<TerminalInput>) =>
  createRemoteWorkspaceAcpTerminal({ ...request, ...overrides, sshOwner });

function fixture() {
  const controller = new AbortController();
  const output = new PassThrough();
  const exit = Promise.withResolvers<AcpOwnerExit>();
  const cancel = vi.fn(async () => {});
  const lease = { output, exit: exit.promise, cancel };
  const runAcpCommand = vi.fn(async (_request: AcpOwnerCommand, _signal: AbortSignal) => lease);
  const selection = {
    kind: "selected",
    identity,
    approval: issueAcpTerminalCommandApproval({ ...command, decision: "accept" }),
    signal: controller.signal,
    owner: { runAcpCommand },
  } satisfies SelectedAcpTerminalOwner;
  return { controller, selection, output, exit, cancel, runAcpCommand, lease };
}

function expectNoFallback() {
  expect(launchSsh).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  expect(createAgentPty).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isDevSshOwnerSelected).mockReturnValue(false);
});

it.each([undefined, ptyResolver])(
  "fails closed when the runtime selects Rust SSH but the caller supplies no owner",
  async (resolver) => {
    vi.mocked(isDevSshOwnerSelected).mockReturnValue(true);
    await expect(
      createRemoteWorkspaceAcpTerminal({ ...request, ptyResolver: resolver }),
    ).rejects.toMatchObject({ code: "ssh-owner-unavailable" });
    expectNoFallback();
  },
);

it("leaves the unselected SSH and remote-agent PTY launch paths unchanged", async () => {
  const args = ["one", "two"];
  const environment = [{ name: "APP_MODE", value: "test" }];
  const original = { ...request, command: "existing-program", args, environment };
  launchSsh.mockReturnValue({ command: "ssh", args: ["invocation"] });
  spawn.mockReturnValue(new EventEmitter());
  await createRemoteWorkspaceAcpTerminal(original);
  expect(launchSsh).toHaveBeenCalledExactlyOnceWith({
    executionTargetId: original.executionTargetId,
    cwd: original.cwd,
    command: original.command,
    args,
    env: { APP_MODE: "test" },
  });
  expect(spawn).toHaveBeenCalledExactlyOnceWith("ssh", ["invocation"], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  expect(createAgentPty).not.toHaveBeenCalled();
  await createRemoteWorkspaceAcpTerminal({ ...original, ptyResolver });
  expect(createAgentPty).toHaveBeenCalledExactlyOnceWith(
    {
      executionTargetId: original.executionTargetId,
      workspaceRoot: original.workspaceRoot,
      cwd: original.cwd,
      command: original.command,
      args,
      cols: 80,
      rows: 24,
      environment,
    },
    ptyResolver,
  );
  expect(launchSsh).toHaveBeenCalledTimes(1);
  expect(spawn).toHaveBeenCalledTimes(1);
});

describe("C11 selected-owner ACP terminal", () => {
  it("passes only the fixed recipe and immutable approval, exact target and cwd; drains UTF-8 before exit", async () => {
    const f = fixture();
    const terminal = await open(f.selection, { args: [], environment: [] });
    expect(f.runAcpCommand).toHaveBeenCalledExactlyOnceWith(command, f.controller.signal);
    const sent = f.runAcpCommand.mock.calls[0]?.[0];
    if (!sent) throw new Error("No owner request recorded.");
    expect(Object.isFrozen(sent)).toBe(true);
    expect(Object.isFrozen(sent.approval)).toBe(true);
    const data = vi.fn();
    const onExit = vi.fn();
    const onError = vi.fn();
    // Simulate owner data/reap before ACP has registered its handlers.
    const bytes = Buffer.from("/work/project/sub dir ☃\n");
    f.output.write(bytes.subarray(0, bytes.length - 2));
    f.exit.resolve({ kind: "exited", code: 7 });
    terminal.onData(data);
    terminal.onExit(onExit);
    terminal.onError(onError);
    await Promise.resolve();
    expect(onExit).not.toHaveBeenCalled();
    f.output.end(bytes.subarray(bytes.length - 2));
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith({ exitCode: 7, signal: null }));
    expect(data.mock.calls.flat().join("")).toBe(bytes.toString());
    expect(onError).not.toHaveBeenCalled();
    const late = vi.fn();
    terminal.onExit(late);
    expect(late).toHaveBeenCalledWith({ exitCode: 7, signal: null });
    await terminal.close();
    expect(f.cancel).not.toHaveBeenCalled();
    expectNoFallback();
  });

  it("uses the exact workspace root when cwd is omitted, without substituting an approved descendant", async () => {
    const f = fixture();
    const { cwd: _cwd, ...withoutCwd } = request;
    await expect(
      createRemoteWorkspaceAcpTerminal({ ...withoutCwd, sshOwner: f.selection }),
    ).rejects.toMatchObject({ code: "approval-mismatch" });
    const rootCommand = { ...command, cwd: command.workspaceRoot };
    const approval = issueAcpTerminalCommandApproval({ ...rootCommand, decision: "accept" });
    const terminal = await createRemoteWorkspaceAcpTerminal({
      ...withoutCwd,
      sshOwner: { ...f.selection, approval },
    });
    expect(f.runAcpCommand).toHaveBeenCalledExactlyOnceWith(rootCommand, f.controller.signal);
    f.output.end();
    f.exit.resolve({ kind: "exited", code: 0 });
    await terminal.close(false);
  });

  it.each([
    ["shell", { command: "sh", args: ["-lc", "pwd"] }, "unsupported-command"],
    ["executable path", { command: "/bin/pwd" }, "unsupported-command"],
    ["args", { args: ["-P"] }, "unsupported-command"],
    ["env", { environment: [{ name: "PATH", value: "/tmp" }] }, "unsupported-command"],
    ["relative cwd", { cwd: "sub dir" }, "unsupported-cwd"],
    ["parent traversal", { cwd: "/work/project/../project/sub dir" }, "unsupported-cwd"],
    ["sibling prefix", { cwd: "/work/project-other" }, "unsupported-cwd"],
    ["different descendant", { cwd: "/work/project/other" }, "approval-mismatch"],
    ["different root", { workspaceRoot: "/work" }, "approval-mismatch"],
    ["different target", { executionTargetId: "ssh:other" }, "approval-mismatch"],
    ["local target", { executionTargetId: "local" }, "unsupported-target"],
    [
      "agent target",
      { executionTargetId: "ssh:host=example&transport=agent" },
      "unsupported-target",
    ],
  ] as const)("denies %s without contacting any transport", async (_name, overrides, code) => {
    const f = fixture();
    await expect(open(f.selection, overrides)).rejects.toMatchObject({ code });
    expect(f.runAcpCommand).not.toHaveBeenCalled();
    expectNoFallback();
  });

  it.each([
    { requestId: ApprovalRequestId.makeUnsafe("another-approval") },
    { threadId: ThreadId.makeUnsafe("another-thread") },
    { sessionEpoch: 4 },
    { acpSessionId: "another-session" },
    { toolCallId: "another-tool" },
  ])("denies a change to trusted launch identity %j", async (change) => {
    const f = fixture();
    await expect(
      open({ ...f.selection, identity: { ...identity, ...change } }),
    ).rejects.toMatchObject({
      code: "approval-mismatch",
    });
    expect(f.runAcpCommand).not.toHaveBeenCalled();
    expectNoFallback();
  });

  it("rejects missing or forged authority and selected-owner absence, with no fallback", async () => {
    const f = fixture();
    const { approval, owner: _owner, identity: _identity, ...unbound } = f.selection;
    await expect(open(unbound)).rejects.toMatchObject({ code: "ssh-owner-unavailable" });
    await expect(open({ ...unbound, owner: f.selection.owner })).rejects.toMatchObject({
      code: "approval-required",
    });
    await expect(open({ ...unbound, owner: f.selection.owner, approval })).rejects.toMatchObject({
      code: "approval-required",
    });
    await expect(open({ ...f.selection, approval: { ...approval } })).rejects.toMatchObject({
      code: "approval-required",
    });
    await expect(open(f.selection, { ptyResolver })).rejects.toMatchObject({
      code: "unsupported-target",
    });
    expect(f.runAcpCommand).not.toHaveBeenCalled();
    expectNoFallback();
  });

  it("does not replay a receipt even across concurrent launches or owner failure", async () => {
    const f = fixture();
    const failure = new Error("Owner refused the route");
    f.runAcpCommand.mockRejectedValue(failure);
    const first = open(f.selection);
    const duplicate = open(f.selection);
    await expect(duplicate).rejects.toMatchObject({ code: "approval-required" });
    await expect(first).rejects.toBe(failure);
    expect(f.runAcpCommand).toHaveBeenCalledTimes(1);
    expectNoFallback();
  });

  it("preserves release without termination and cancels only the exact lease on abort or kill", async () => {
    const first = fixture();
    const second = fixture();
    const a = await open(first.selection);
    const b = await open(second.selection);
    const exit = vi.fn();
    a.onExit(exit);
    await a.close(false);
    expect(first.cancel).not.toHaveBeenCalled();
    first.controller.abort();
    a.kill("SIGKILL");
    const closed = vi.fn();
    const closing = a.close().then(closed);
    await vi.waitFor(() => expect(first.cancel).toHaveBeenCalledTimes(1));
    expect(first.cancel).toHaveBeenCalledWith();
    expect(second.cancel).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    first.output.end();
    first.exit.resolve({ kind: "signaled", signal: "SIGTERM" });
    await closing;
    expect(exit).toHaveBeenCalledWith({ exitCode: null, signal: "SIGTERM" });
    await b.close(false);
    second.output.end();
    second.exit.resolve({ kind: "exited", code: 0 });
    expectNoFallback();
  });

  it("rejects abort before launch and cancels a late lease without exposing it", async () => {
    const f = fixture();
    const early = AbortSignal.abort(new Error("already cancelled"));
    await expect(open({ ...f.selection, signal: early })).rejects.toBe(early.reason);
    expect(f.runAcpCommand).not.toHaveBeenCalled();
    const acquired = Promise.withResolvers<typeof f.lease>();
    f.runAcpCommand.mockReturnValue(acquired.promise);
    const opening = open(f.selection);
    f.controller.abort(new Error("cancelled during acquisition"));
    acquired.resolve(f.lease);
    await vi.waitFor(() => expect(f.cancel).toHaveBeenCalledExactlyOnceWith());
    f.output.end();
    f.exit.resolve({ kind: "signaled", signal: "SIGTERM" });
    await expect(opening).rejects.toBe(f.controller.signal.reason);
    expectNoFallback();
  });

  it("cancels on kill without a session abort, and cancels on a broken output pipe", async () => {
    const killed = fixture();
    const broken = fixture();
    const a = await open(killed.selection);
    const b = await open(broken.selection);
    a.kill("SIGKILL");
    await vi.waitFor(() => expect(killed.cancel).toHaveBeenCalledExactlyOnceWith());
    expect(killed.controller.signal.aborted).toBe(false);
    expect(broken.cancel).not.toHaveBeenCalled();
    killed.output.end();
    killed.exit.resolve({ kind: "signaled", signal: "SIGTERM" });
    await a.close();

    const error = new Error("owner output disconnected");
    const onError = vi.fn();
    const onExit = vi.fn();
    b.onError(onError);
    b.onExit(onExit);
    broken.output.destroy(error);
    await vi.waitFor(() => expect(broken.cancel).toHaveBeenCalledExactlyOnceWith());
    broken.exit.resolve({ kind: "exited", code: 0 });
    await expect(b.close()).rejects.toBe(error);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(onExit).not.toHaveBeenCalled();
    expectNoFallback();
  });

  it("reports lost exit confirmation, not a successful exit, and does not retry another route", async () => {
    const f = fixture();
    const terminal = await open(f.selection);
    const error = new Error("exit unconfirmed");
    const onError = vi.fn();
    const onExit = vi.fn();
    f.exit.reject(error);
    await expect(terminal.close()).rejects.toBe(error);
    terminal.onError(onError);
    terminal.onExit(onExit);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(onExit).not.toHaveBeenCalled();
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith();
    expectNoFallback();
  });
});
