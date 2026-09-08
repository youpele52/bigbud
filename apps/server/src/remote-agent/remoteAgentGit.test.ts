import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { RemoteAgentProcessClient } from "./remoteAgentProcessClient.ts";
import { makeRemoteAgentGitCoreExecutor, makeRemoteAgentGitExecutor } from "./remoteAgentGit.ts";

function makeProcessClient(input: {
  readonly received: Array<Record<string, unknown>>;
  readonly outputTruncated?: boolean;
}): RemoteAgentProcessClient {
  return {
    connection: {
      request: async () => ({
        type: "workspaceOpenResponse",
        value: {
          requestId: "open",
          workspaceHandle: "workspace",
          accepted: true,
          errorCode: "",
          errorMessage: "",
        },
      }),
    },
    run: async (request: Record<string, unknown>) => {
      input.received.push(request);
      return {
        accepted: true,
        duplicate: false,
        stdout: new TextEncoder().encode("On branch main\n"),
        stderr: new Uint8Array(),
        completed: {
          requestId: "request",
          operationId: "operation",
          state: "completed",
          hasExitCode: true,
          exitCode: 0,
          outputTruncated: input.outputTruncated ?? false,
          errorCode: "",
          errorMessage: "",
        },
      };
    },
  } as unknown as RemoteAgentProcessClient;
}

describe("remote agent Git executor", () => {
  it("uses the bounded process contract and preserves Git output", async () => {
    const received: Array<Record<string, unknown>> = [];
    const processClient = makeProcessClient({ received });
    const execute = makeRemoteAgentGitExecutor({ resolve: async () => processClient });
    const result = await Effect.runPromise(
      execute({
        executionTargetId: "ssh:example",
        cwd: "/remote/project",
        operation: "git.status",
        args: ["status", "--short"],
        stdin: "input",
      }),
    );
    expect(result.stdout).toBe("On branch main\n");
    expect(received[0]?.command).toBe("git");
    expect(received[0]?.args).toEqual(["status", "--short"]);
    expect((received[0]?.requestDigest as Uint8Array | undefined)?.byteLength).toBe(32);
    expect(new TextDecoder().decode(received[0]?.stdin as Uint8Array)).toBe("input");

    await Effect.runPromise(
      execute({
        executionTargetId: "ssh:example",
        cwd: "/remote/project",
        operation: "git.status",
        args: ["status", "--short"],
        operationId: "git-operation-2",
      }),
    );
    expect(received[1]?.operationId).toBe("git-operation-2");
    expect(received[0]?.operationId).not.toBe(received[1]?.operationId);
  });

  it("rejects incomplete output unless truncation was requested", async () => {
    const processClient = makeProcessClient({ received: [], outputTruncated: true });
    const execute = makeRemoteAgentGitExecutor({ resolve: async () => processClient });
    const input = {
      executionTargetId: "ssh:example",
      cwd: "/remote/project",
      operation: "git.log",
      args: ["log"],
    } as const;

    await expect(Effect.runPromise(execute(input))).rejects.toMatchObject({
      _tag: "GitCommandError",
    });
    await expect(
      Effect.runPromise(execute({ ...input, truncateOutputAtMaxBytes: true })),
    ).resolves.toMatchObject({ stdoutTruncated: true, stderrTruncated: true });
  });

  it("forwards bounded Git environment values without secrets", async () => {
    const received: Array<Record<string, unknown>> = [];
    const execute = makeRemoteAgentGitCoreExecutor({
      resolve: async () => makeProcessClient({ received }),
    });

    await Effect.runPromise(
      execute({
        executionTargetId: "ssh:example",
        cwd: "/remote/project",
        operation: "git.commit",
        args: ["commit"],
        env: {
          GIT_AUTHOR_NAME: "Remote Author",
          GIT_COMMITTER_EMAIL: "committer@example.com",
          GIT_CONFIG: "/remote/config",
          GIT_ASKPASS: "/remote/askpass",
          HOME: "/home/remote",
          SSH_AUTH_SOCK: "/tmp/agent.sock",
          AWS_SECRET_ACCESS_KEY: "not-forwarded",
        },
      }),
    );

    expect(received[0]?.environment).toEqual([
      { name: "GIT_TERMINAL_PROMPT", value: "0" },
      { name: "GIT_AUTHOR_NAME", value: "Remote Author" },
      { name: "GIT_COMMITTER_EMAIL", value: "committer@example.com" },
      { name: "GIT_CONFIG", value: "/remote/config" },
      { name: "GIT_ASKPASS", value: "/remote/askpass" },
    ]);
  });
});
