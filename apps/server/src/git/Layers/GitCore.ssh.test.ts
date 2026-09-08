import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runSshCommand } from "../../ssh/sshProcess.ts";
import { makeSshGitExecutor } from "./GitCore.ssh.ts";

vi.mock("../../ssh/sshProcess.ts", () => ({
  runSshCommand: vi.fn(),
}));

const READ_COMMANDS = [
  ["status", "--short", "--branch"],
  ["log", "--max-count=20"],
  ["diff", "--numstat"],
  ["branch", "--show-current"],
  ["branch", "--no-color", "--no-column"],
  ["branch", "--no-color", "--no-column", "--remotes"],
  ["config", "--get", "remote.pushDefault"],
  ["remote"],
  ["remote", "-v"],
  ["remote", "get-url", "origin"],
  ["symbolic-ref", "refs/remotes/origin/HEAD"],
  ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
  ["worktree", "list", "--porcelain"],
] as const;

const MUTATION_COMMANDS = [
  ["commit", "-m", "message"],
  ["branch", "feature/new"],
  ["branch", "feature/new", "main"],
  ["branch", "-c", "feature/copy"],
  ["branch", "--copy", "feature/copy"],
  ["branch", "-m", "feature/renamed"],
  ["branch", "--move", "feature/renamed"],
  ["branch", "-d", "feature/delete"],
  ["branch", "--delete", "feature/delete"],
  ["branch", "--set-upstream-to", "origin/main"],
  ["branch", "--unset-upstream"],
  ["branch", "--create-reflog", "feature/reflog"],
  ["branch", "--edit-description", "main"],
  ["config", "user.name", "Mutation"],
  ["remote", "add", "origin", "git@example.com:repo.git"],
  ["symbolic-ref", "refs/heads/current", "refs/heads/main"],
  ["symbolic-ref", "--delete", "refs/heads/current"],
  ["worktree", "add", "/srv/other", "main"],
] as const;

const toCommandArgs = (args: ReadonlyArray<string | undefined>): ReadonlyArray<string> =>
  args.filter((arg): arg is string => arg !== undefined);

describe("makeSshGitExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runSshCommand).mockResolvedValue({
      code: 0,
      signal: null,
      stderr: "",
      stdout: "output",
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  });

  it.each(READ_COMMANDS)("executes the read-only command %j through SSH", async (...args) => {
    const commandArgs = toCommandArgs(args);
    const result = await Effect.runPromise(
      makeSshGitExecutor()({
        operation: "GitCore.read",
        cwd: "/srv/project",
        executionTargetId: "ssh:example",
        args: commandArgs,
      }),
    );

    expect(result.stdout).toBe("output");
    expect(runSshCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        executionTargetId: "ssh:example",
        cwd: "/srv/project",
        command: "git",
        args: commandArgs,
      }),
    );
  });

  it.each(MUTATION_COMMANDS)("rejects the mutation command %j before SSH", async (...args) => {
    const commandArgs = toCommandArgs(args);
    await expect(
      Effect.runPromise(
        makeSshGitExecutor()({
          operation: "GitCore.mutation",
          cwd: "/srv/project",
          executionTargetId: "ssh:example",
          args: commandArgs,
        }),
      ),
    ).rejects.toThrow("install the remote agent");
    expect(runSshCommand).not.toHaveBeenCalled();
  });

  it("forwards only bounded Git environment values", async () => {
    await Effect.runPromise(
      makeSshGitExecutor()({
        operation: "GitCore.read",
        cwd: "/srv/project",
        executionTargetId: "ssh:example",
        args: ["status", "--short", "--branch"],
        env: {
          GIT_CONFIG: "/remote/config",
          GIT_ASKPASS: "/remote/askpass",
          AWS_SECRET_ACCESS_KEY: "not-forwarded",
        },
      }),
    );

    const sshInput = vi.mocked(runSshCommand).mock.calls[0]?.[0];
    expect(sshInput?.env).toMatchObject({
      GIT_CONFIG: "/remote/config",
      GIT_ASKPASS: "/remote/askpass",
    });
    expect(sshInput?.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });
});
