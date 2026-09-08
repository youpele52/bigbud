import { describe, expect, it } from "vitest";

import type { RemoteAgentProcessClient } from "./remoteAgentProcessClient.ts";
import { makeRemoteAgentToolRunner } from "./remoteAgentToolRunner.ts";

function makeProcessClient(input: {
  readonly exitCode?: number;
  readonly outputTruncated?: boolean;
  readonly received: Array<Record<string, unknown>>;
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
        stdout: new TextEncoder().encode("stdout"),
        stderr: new TextEncoder().encode(input.exitCode ? "failure" : ""),
        completed: {
          requestId: "request",
          operationId: "operation",
          state: "completed",
          hasExitCode: true,
          exitCode: input.exitCode ?? 0,
          outputTruncated: input.outputTruncated ?? false,
          errorCode: input.exitCode ? "NONZERO_EXIT" : "",
          errorMessage: input.exitCode ? "failure" : "",
        },
      };
    },
  } as unknown as RemoteAgentProcessClient;
}

describe("remote agent tool runner", () => {
  it("opens the workspace and sends a bounded digest and allowlisted environment", async () => {
    const received: Array<Record<string, unknown>> = [];
    const runner = makeRemoteAgentToolRunner({
      resolve: async () => makeProcessClient({ received }),
    });

    const result = await runner({
      executionTargetId: "ssh:example",
      cwd: "/srv/project",
      command: "git",
      args: ["status", "--short"],
      env: { LANG: "C.UTF-8", SECRET: "not-forwarded" },
      stdin: "input",
      maxBufferBytes: 64 * 1024,
    });

    expect(result).toMatchObject({ stdout: "stdout", code: 0, timedOut: false });
    expect(received[0]).toMatchObject({
      command: "git",
      args: ["status", "--short"],
      maxOutputBytes: 64 * 1024,
      environment: [{ name: "LANG", value: "C.UTF-8" }],
    });
    const request = received[0];
    expect(request).toBeDefined();
    expect((request?.requestDigest as Uint8Array | undefined)?.byteLength).toBe(32);
    expect(new TextDecoder().decode(request?.stdin as Uint8Array)).toBe("input");
  });

  it("preserves explicit nonzero handling", async () => {
    const runner = makeRemoteAgentToolRunner({
      resolve: async () => makeProcessClient({ received: [], exitCode: 7 }),
    });
    const input = {
      executionTargetId: "ssh:example",
      cwd: "/srv/project",
      command: "false",
    } as const;

    await expect(runner(input)).rejects.toThrow("failed (code=7)");
    await expect(runner({ ...input, allowNonZeroExit: true })).resolves.toMatchObject({ code: 7 });
  });
});
