import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./toolTransport.local.ts", () => ({
  runLocalToolCommand: vi.fn(),
}));

vi.mock("./toolTransport.ssh.ts", () => ({
  runSshToolCommand: vi.fn(),
}));

import { runLocalToolCommand } from "./toolTransport.local.ts";
import { runSshToolCommand } from "./toolTransport.ssh.ts";
import { resolveToolTransportTarget, runToolCommand } from "./toolTransport.ts";

describe("toolTransport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves ssh transport for remote workspace targets", () => {
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

  it("dispatches remote commands through the ssh tool runner", async () => {
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
