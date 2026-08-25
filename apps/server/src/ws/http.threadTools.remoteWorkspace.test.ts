import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { runToolCommand } from "../tool-transport/toolTransport.ts";
import { runRemoteWorkspaceProcess } from "./http.threadTools.remoteWorkspace.ts";

vi.mock("../tool-transport/toolTransport.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tool-transport/toolTransport.ts")>();
  return { ...actual, runToolCommand: vi.fn() };
});

const threadId = ThreadId.makeUnsafe("thread-remote-workspace");
const projectId = ProjectId.makeUnsafe("project-remote-workspace");

function engineLayer(input: {
  readonly executionTargetId: string;
  readonly workspaceRoot: string | null;
}) {
  return Layer.succeed(OrchestrationEngineService, {
    getReadModel: () =>
      Effect.succeed({
        threads: [
          {
            id: threadId,
            projectId,
            worktreePath: null,
            workspaceExecutionTargetId: input.executionTargetId,
          },
        ],
        projects: [
          {
            id: projectId,
            workspaceRoot: input.workspaceRoot,
            workspaceExecutionTargetId: input.executionTargetId,
          },
        ],
      }),
  } as never);
}

describe("remote workspace thread tool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("derives the target from the authenticated thread and dispatches through the agent", async () => {
    vi.mocked(runToolCommand).mockResolvedValueOnce({
      stdout: "ok\n",
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
    });

    const result = await Effect.runPromise(
      runRemoteWorkspaceProcess({
        callerThreadId: threadId,
        request: {
          remoteCommand: "git",
          remoteArgs: ["status", "--short"],
          remoteTimeoutMs: 5_000,
          remoteMaxOutputBytes: 64 * 1024,
        },
      }).pipe(
        Effect.provide(
          engineLayer({
            executionTargetId: "ssh:host=devbox&user=root&port=22",
            workspaceRoot: "/srv/project",
          }),
        ),
      ),
    );

    expect(result.stdout).toBe("ok\n");
    expect(runToolCommand).toHaveBeenCalledWith({
      target: {
        transport: "agent",
        executionTargetId: "ssh:host=devbox&user=root&port=22",
        cwd: "/srv/project",
      },
      command: "git",
      args: ["status", "--short"],
      allowNonZeroExit: false,
      timeoutMs: 5_000,
      maxBufferBytes: 64 * 1024,
      outputMode: "error",
    });
  });

  it("rejects a local thread target", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        runRemoteWorkspaceProcess({
          callerThreadId: threadId,
          request: { remoteCommand: "pwd" },
        }).pipe(
          Effect.provide(
            engineLayer({ executionTargetId: "local", workspaceRoot: "/tmp/project" }),
          ),
        ),
      ),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(String(result.failure)).toContain("does not use a remote workspace");
    }
    expect(runToolCommand).not.toHaveBeenCalled();
  });
});
