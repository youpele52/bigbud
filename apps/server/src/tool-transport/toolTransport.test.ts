import { beforeEach, describe, expect, it, vi } from "vitest";

const { remoteAgentToolRunner } = vi.hoisted(() => ({
  remoteAgentToolRunner: vi.fn(),
}));

vi.mock("./toolTransport.local.ts", () => ({
  runLocalToolCommand: vi.fn(),
}));

vi.mock("./toolTransport.ssh.ts", () => ({
  runSshToolCommand: vi.fn(),
}));

vi.mock("../remote-agent/remoteAgentDefault.ts", () => ({
  resolveRemoteAgentConfiguration: vi.fn(() => ({
    transport: "agent",
    binaryPath: "$HOME/.bigbud/agent/bin/current",
  })),
  getConfiguredRemoteAgentComposition: vi.fn(() => ({ toolRunner: remoteAgentToolRunner })),
}));

import { runLocalToolCommand } from "./toolTransport.local.ts";
import { runSshToolCommand } from "./toolTransport.ssh.ts";
import { resolveRemoteAgentConfiguration } from "../remote-agent/remoteAgentDefault.ts";
import { resolveToolTransportTarget, runToolCommand } from "./toolTransport.ts";

describe("toolTransport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves agent transport for remote workspace targets by default", () => {
    expect(
      resolveToolTransportTarget({
        location: "remote",
        executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        cwd: "/root/project",
      }),
    ).toEqual({
      transport: "agent",
      executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      cwd: "/root/project",
    });
  });

  it("resolves the explicit direct SSH fallback before command dispatch", () => {
    vi.mocked(resolveRemoteAgentConfiguration).mockReturnValueOnce({
      transport: "direct-ssh",
      binaryPath: null,
    });

    expect(
      resolveToolTransportTarget({
        location: "remote",
        executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        cwd: "/root/project",
      }),
    ).toEqual({
      transport: "ssh",
      executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      cwd: "/root/project",
    });
  });

  it("dispatches default remote commands through the remote agent", async () => {
    remoteAgentToolRunner.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
    });

    await runToolCommand({
      target: {
        transport: "agent",
        executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        cwd: "/root/project",
      },
      command: "git",
      args: ["status"],
    });

    expect(remoteAgentToolRunner).toHaveBeenCalledWith({
      executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      cwd: "/root/project",
      command: "git",
      args: ["status"],
    });
    expect(runSshToolCommand).not.toHaveBeenCalled();
  });

  it("dispatches local commands through the local tool runner", async () => {
    vi.mocked(runLocalToolCommand).mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
    });

    await runToolCommand({
      target: {
        transport: "local",
        executionTargetId: "local",
        cwd: "/tmp/project",
      },
      command: "git",
      args: ["status"],
    });

    expect(runLocalToolCommand).toHaveBeenCalledWith({
      command: "git",
      args: ["status"],
      cwd: "/tmp/project",
      env: undefined,
      stdin: undefined,
      allowNonZeroExit: undefined,
      timeoutMs: undefined,
      maxBufferBytes: undefined,
      outputMode: undefined,
    });
    expect(runSshToolCommand).not.toHaveBeenCalled();
  });

  it("keeps explicit fallback commands on the ssh tool runner", async () => {
    vi.mocked(runSshToolCommand).mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
    });

    await runToolCommand({
      target: {
        transport: "ssh",
        executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        cwd: "/root/project",
      },
      command: "git",
      args: ["status"],
      timeoutMs: 5_000,
    });

    expect(runSshToolCommand).toHaveBeenCalledWith({
      executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      cwd: "/root/project",
      env: undefined,
      command: "git",
      args: ["status"],
      allocateTty: undefined,
      stdin: undefined,
      allowNonZeroExit: undefined,
      timeoutMs: 5_000,
      maxBufferBytes: undefined,
      outputMode: undefined,
    });
    expect(runLocalToolCommand).not.toHaveBeenCalled();
  });
});
