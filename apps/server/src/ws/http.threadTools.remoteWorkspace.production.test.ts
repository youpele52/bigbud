import { Effect, Layer } from "effect";
import { beforeEach, expect, it, vi } from "vitest";

import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { runToolCommand } from "../tool-transport/toolTransport.ts";
import { runRemoteWorkspaceProcess } from "./http.threadTools.remoteWorkspace.ts";
import { makeProductionProviderWorkspaceShell } from "./remoteWorkspaceProviderShell.ts";
import {
  runLegacyRemoteWorkspaceTool,
  runOwnedRemoteWorkspaceTool,
} from "./http.threadTools.remoteWorkspaceTool.ts";

vi.mock("../tool-transport/toolTransport.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tool-transport/toolTransport.ts")>()),
  runToolCommand: vi.fn(),
}));
vi.mock("./remoteWorkspaceProviderShell.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./remoteWorkspaceProviderShell.ts")>()),
  makeProductionProviderWorkspaceShell: vi.fn(),
}));
vi.mock("./http.threadTools.remoteWorkspaceTool.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http.threadTools.remoteWorkspaceTool.ts")>()),
  runOwnedRemoteWorkspaceTool: vi.fn(async () => ({ tool: "write_text", path: "a" })),
  runLegacyRemoteWorkspaceTool: vi.fn(async () => ({ tool: "write_text", path: "a" })),
}));

const threadId = ThreadId.makeUnsafe("thread-production-shell");
const projectId = ProjectId.makeUnsafe("project-production-shell");
const target = "ssh:host=devbox&user=root&port=22&transport=direct-ssh";
const root = "/srv/project";

const engine = Layer.succeed(OrchestrationEngineService, {
  getReadModel: () =>
    Effect.succeed({
      threads: [
        { id: threadId, projectId, worktreePath: null, workspaceExecutionTargetId: target },
      ],
      projects: [{ id: projectId, workspaceRoot: root, workspaceExecutionTargetId: target }],
    }),
} as never);

const shellRun = vi.fn(async (_input: { command: string }) => ({
  output: "out\n",
  exitCode: 0,
  truncated: false,
  timedOut: false,
}));

const dispatch = (request: Record<string, unknown>, productionActivation = true) =>
  Effect.runPromise(
    Effect.result(
      runRemoteWorkspaceProcess({
        callerThreadId: threadId,
        productionActivation,
        request: { remoteInvocationId: "call-1", ...request },
      }).pipe(Effect.provide(engine)),
    ),
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(makeProductionProviderWorkspaceShell).mockReturnValue({
    targetId: target,
    workspaceRoot: root,
    run: shellRun,
  });
});

it("treats exactly `sh -lc <text>` as the bash command text, without the fixed-tool check", async () => {
  const result = await dispatch({ remoteCommand: "sh", remoteArgs: ["-lc", "cat a.txt && ls"] });
  expect(result._tag).toBe("Success");
  expect(shellRun).toHaveBeenCalledWith(
    expect.objectContaining({ command: "cat a.txt && ls", cwd: root, provider: "thread-tool" }),
    undefined,
  );
  expect(runToolCommand).not.toHaveBeenCalled();
});

it("still refuses stdin, extra argv and a plain fixed-tool command in production", async () => {
  for (const request of [
    { remoteCommand: "sh", remoteArgs: ["-lc", "cat > f"], remoteStdin: "x" },
    { remoteCommand: "sh", remoteArgs: ["-lc", "echo $1", "arg"] },
    { remoteCommand: "cat", remoteArgs: [] },
  ]) {
    const result = await dispatch(request);
    expect(result._tag, JSON.stringify(request)).toBe("Failure");
  }
  expect(shellRun).not.toHaveBeenCalled();
  expect(runToolCommand).not.toHaveBeenCalled();
});

it("routes typed bridge tools to the owner in production and to the fixed scripts on legacy", async () => {
  const tool = { tool: "write_text", path: "a", content: "x" };
  const owned = await dispatch({ remoteTool: tool });
  expect(owned._tag).toBe("Success");
  expect(runOwnedRemoteWorkspaceTool).toHaveBeenCalledWith(
    expect.objectContaining({ targetId: target, workspaceRoot: root }),
    tool,
    expect.any(AbortSignal),
    expect.any(Function),
  );
  const legacy = await dispatch({ remoteTool: tool }, false);
  expect(legacy._tag).toBe("Success");
  expect(runLegacyRemoteWorkspaceTool).toHaveBeenCalledTimes(1);
  const invalid = await dispatch({ remoteTool: { tool: "exec", command: "id" } });
  expect(invalid._tag).toBe("Failure");
});
