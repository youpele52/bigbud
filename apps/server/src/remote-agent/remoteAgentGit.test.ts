import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { RemoteAgentProcessClient } from "./remoteAgentProcessClient.ts";
import { makeRemoteAgentGitExecutor } from "./remoteAgentGit.ts";

describe("remote agent Git executor", () => {
  it("uses the bounded process contract and preserves Git output", async () => {
    const received: Array<{
      command: string;
      args: ReadonlyArray<string>;
      stdin?: Uint8Array;
      operationId?: string;
    }> = [];
    const processClient = {
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
      run: async (input: { command: string; args: ReadonlyArray<string>; stdin?: Uint8Array }) => {
        received.push(input);
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
            outputTruncated: false,
            errorCode: "",
            errorMessage: "",
          },
        };
      },
    } as unknown as RemoteAgentProcessClient;
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
    expect(new TextDecoder().decode(received[0]?.stdin)).toBe("input");

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
});
