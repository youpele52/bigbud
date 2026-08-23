import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runSshCommand } from "../../ssh/sshProcess.ts";
import { makeSshGitExecutor } from "./GitCore.ssh.ts";

vi.mock("../../ssh/sshProcess.ts", () => ({
  runSshCommand: vi.fn(),
}));

describe("makeSshGitExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes remote history commands through SSH", async () => {
    vi.mocked(runSshCommand).mockResolvedValue({
      code: 0,
      signal: null,
      stderr: "",
      stdout: "commit output",
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    });

    const result = await Effect.runPromise(
      makeSshGitExecutor()({
        operation: "GitCore.listCommits",
        cwd: "/srv/project",
        executionTargetId: "ssh:example",
        args: ["log", "--max-count=20"],
      }),
    );

    expect(result.stdout).toBe("commit output");
    expect(runSshCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        executionTargetId: "ssh:example",
        cwd: "/srv/project",
        command: "git",
        args: ["log", "--max-count=20"],
      }),
    );
  });

  it("does not use the fallback for mutations", async () => {
    await expect(
      Effect.runPromise(
        makeSshGitExecutor()({
          operation: "GitCore.commit",
          cwd: "/srv/project",
          executionTargetId: "ssh:example",
          args: ["commit", "-m", "message"],
        }),
      ),
    ).rejects.toThrow("install the remote agent");
    expect(runSshCommand).not.toHaveBeenCalled();
  });
});
