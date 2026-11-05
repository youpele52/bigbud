import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { afterEach, describe, expect, vi } from "vitest";

import { prepareV2SharedCanonicalResources } from "../provider/Layers/OpencodeV2/Application.targets.auth.ts";
import { setThreadOrchestrationToolDispatcher } from "../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { buildAppUnderTest, getHttpServerUrl, serverTestLayer } from "../server.test.helpers.ts";
import { makeDefaultOrchestrationReadModel } from "../server.test.fixtures.ts";
import { serverHttpTestLayer } from "../server.test.http.ts";
import { deriveServerPaths } from "../startup/config.ts";
import { runToolCommand } from "../tool-transport/toolTransport.ts";

vi.mock("../tool-transport/toolTransport.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tool-transport/toolTransport.ts")>()),
  runToolCommand: vi.fn(),
}));

const original = { executionTargetId: "ssh:host=original&user=root", cwd: "/srv/original" };

describe("workspace-bound OpenCode v2 HTTP tools", () => {
  afterEach(() => {
    vi.clearAllMocks();
    setThreadOrchestrationToolDispatcher(null);
  });

  it.layer(serverTestLayer)("POST /api/internal/thread-tools", (it) => {
    it.effect("rejects workspace edits and client-supplied bindings without dispatching", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "workspace-auth-" });
        const { stateDir } = yield* deriveServerPaths(baseDir, undefined);
        const model = makeDefaultOrchestrationReadModel();
        let thread = {
          ...model.threads[0]!,
          executionTargetId: "local",
          workspaceExecutionTargetId: original.executionTargetId,
          worktreePath: null as string | null,
        };
        let project = { ...model.projects[0]!, workspaceRoot: original.cwd };
        let auth = yield* Effect.promise(() =>
          prepareV2SharedCanonicalResources(stateDir, thread.id, 12345, original),
        );
        setThreadOrchestrationToolDispatcher({
          rename: () => Effect.die("unused"),
          archive: () => Effect.die("unused"),
          getStatus: () => Effect.die("unused"),
          listPinned: () => Effect.die("unused"),
          setPinned: () => Effect.die("unused"),
          computerUse: () => Effect.die("unused"),
          browser: () => Effect.die("unused"),
        });
        yield* buildAppUnderTest({
          config: { baseDir },
          layers: {
            orchestrationEngine: {
              getReadModel: () =>
                Effect.succeed({ ...model, threads: [thread], projects: [project] }),
            },
          },
        });
        vi.mocked(runToolCommand).mockResolvedValue({
          stdout: "ok",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        });
        const url = yield* getHttpServerUrl("/api/internal/thread-tools");
        const call = () =>
          Effect.promise(() =>
            fetch(url, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-bigbud-thread-tool-token": auth.orchestration.token,
              },
              body: JSON.stringify({
                action: "remote_workspace_process",
                remoteInvocationId: crypto.randomUUID(),
                remoteCommand: "pwd",
                // Neither current metadata nor an agent-supplied binding may redirect the credential.
                workspaceBinding: {
                  executionTargetId: thread.workspaceExecutionTargetId,
                  cwd: thread.worktreePath ?? project.workspaceRoot,
                },
              }),
            }),
          );
        expect((yield* call()).status).toBe(200);
        expect((yield* call()).status).toBe(200);
        expect(runToolCommand).toHaveBeenCalledTimes(2);
        expect(runToolCommand).toHaveBeenLastCalledWith(
          expect.objectContaining({
            target: { transport: "agent", ...original },
          }),
        );
        vi.mocked(runToolCommand).mockClear();

        project = { ...project, workspaceRoot: "/srv/other" };
        expect((yield* call()).status).toBe(409);
        project = { ...project, workspaceRoot: original.cwd };
        thread = { ...thread, worktreePath: "/srv/worktree" };
        expect((yield* call()).status).toBe(409);
        thread = { ...thread, worktreePath: null, workspaceExecutionTargetId: "ssh:host=other" };
        expect((yield* call()).status).toBe(409);
        thread = { ...thread, workspaceExecutionTargetId: "local" };
        expect((yield* call()).status).toBe(400);
        expect(runToolCommand).not.toHaveBeenCalled();

        thread = { ...thread, workspaceExecutionTargetId: original.executionTargetId };
        expect((yield* call()).status).toBe(200);
        expect(runToolCommand).toHaveBeenCalledTimes(1);
        yield* Effect.promise(auth.cleanup);
        expect((yield* call()).status).toBe(401);
        expect(runToolCommand).toHaveBeenCalledTimes(1);

        // A local v2 session cannot gain VPS authority from later metadata edits either.
        auth = yield* Effect.promise(() =>
          prepareV2SharedCanonicalResources(stateDir, thread.id, 12345, {
            executionTargetId: "local",
            cwd: original.cwd,
          }),
        );
        expect((yield* call()).status).toBe(409);
        expect(runToolCommand).toHaveBeenCalledTimes(1);
        yield* Effect.promise(auth.cleanup);
      }).pipe(Effect.provide(serverHttpTestLayer)),
    );
  });
});
