import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { RemoteAgentProcessClient } from "./remoteAgentProcessClient.ts";
import { makeRemoteAgentShellRunnerResolver } from "./remoteAgentShell.ts";

describe("remote agent shell runner", () => {
  it("opens the remote workspace and runs a bounded shell command", async () => {
    const received: Array<{
      command: string;
      args: ReadonlyArray<string>;
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
      run: async (input: { command: string; args: ReadonlyArray<string> }) => {
        received.push(input);
        return {
          accepted: true,
          duplicate: false,
          stdout: new TextEncoder().encode("remote output\n"),
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
    const resolver = makeRemoteAgentShellRunnerResolver({
      resolve: async () => processClient,
    });
    const runner = resolver.resolve("ssh:example");
    let output = "";

    const result = await Effect.runPromise(
      runner.run({
        threadId: "thread-1",
        cwd: "/remote/project",
        command: "printf remote",
        onOutputChunk: (chunk) => {
          output += chunk;
        },
      }),
    );

    expect(result).toEqual({ output: "remote output\n", exitCode: 0 });
    expect(output).toBe("remote output\n");
    expect(received[0]).toMatchObject({ command: "/bin/sh", args: ["-lc", "printf remote"] });

    await Effect.runPromise(
      runner.run({
        threadId: "thread-1",
        cwd: "/remote/project",
        command: "printf remote",
      }),
    );
    expect(received[0]?.operationId).not.toBe(received[1]?.operationId);
  });
});
