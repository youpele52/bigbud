import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { setThreadOrchestrationToolDispatcher } from "../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { prepareV2SharedCanonicalResources } from "../provider/Layers/OpencodeV2/Application.targets.auth.ts";
import { defaultThreadId, makeDefaultOrchestrationReadModel } from "../server.test.fixtures.ts";
import { SSH_CANCEL_COMMAND, SSH_OWNED_COMMAND } from "../ssh/sshCommand.cancellation.ts";
import { runSshCommand, type RunSshCommandInput } from "../ssh/sshProcess.ts";
import { deriveServerPaths, ServerConfig } from "../startup/config.ts";
import { threadOrchestrationToolsRouteLayer } from "./http.threadTools.ts";

vi.mock("../ssh/sshProcess.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ssh/sshProcess.ts")>()),
  runSshCommand: vi.fn(),
}));

it("sends owned SSH cancellation when the HTTP caller aborts after remote workspace dispatch", async () => {
  const binding = {
    executionTargetId: "ssh:host=callback.invalid&user=fixture&transport=direct-ssh",
    cwd: "/srv/fixture",
  };
  const defaults = makeDefaultOrchestrationReadModel();
  const model = {
    ...defaults,
    projects: [{ ...defaults.projects[0]!, workspaceRoot: binding.cwd }],
    threads: [{ ...defaults.threads[0]!, workspaceExecutionTargetId: binding.executionTargetId }],
  };
  const entered = Deferred.makeUnsafe<RunSshCommandInput>();
  const cancelled = Deferred.makeUnsafe<RunSshCommandInput>();
  const release = Deferred.makeUnsafe<void>();
  const result = { stdout: "", stderr: "", code: 0, signal: null, timedOut: false };
  vi.mocked(runSshCommand).mockImplementation(async (input) => {
    if (input.args?.[1] === SSH_OWNED_COMMAND) {
      await Effect.runPromise(Deferred.succeed(entered, input));
      await Effect.runPromise(Deferred.await(release));
    } else if (input.args?.[1] === SSH_CANCEL_COMMAND) {
      await Effect.runPromise(Deferred.succeed(cancelled, input));
    }
    return result;
  });

  const baseDir = await mkdtemp(path.join(tmpdir(), "ssh-callback-cancellation-"));
  try {
    const { stateDir } = await Effect.runPromise(
      deriveServerPaths(baseDir, undefined).pipe(Effect.provide(NodeServices.layer)),
    );
    const resources = await prepareV2SharedCanonicalResources(
      stateDir,
      defaultThreadId,
      12345,
      binding,
    );
    const app = HttpRouter.toWebHandler(
      threadOrchestrationToolsRouteLayer.pipe(
        HttpRouter.provideRequest(
          Layer.mergeAll(
            ServerConfig.layerTest(baseDir, baseDir),
            Layer.mock(OrchestrationEngineService)({
              getThread: (id) => Effect.succeed(model.threads.find((thread) => thread.id === id)),
              getReadModel: () => Effect.succeed(model),
            }),
          ),
        ),
        Layer.provide(NodeServices.layer),
      ),
      { disableLogger: true },
    );
    const unused = () => Effect.die("Unexpected orchestration dispatch");
    setThreadOrchestrationToolDispatcher({
      rename: unused,
      archive: unused,
      getStatus: unused,
      listPinned: unused,
      setPinned: unused,
      computerUse: unused,
      browser: unused,
    });
    try {
      const controller = new AbortController();
      const pending = app.handler(
        new Request("http://callback.invalid/api/internal/thread-tools", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "x-bigbud-thread-tool-token": resources.orchestration.token,
          },
          body: JSON.stringify({
            action: "remote_workspace_process",
            remoteInvocationId: "aborted-turn:0",
            remoteCommand: "pwd",
          }),
        }),
      );
      const command = await Effect.runPromise(
        Deferred.await(entered).pipe(Effect.timeout("2 seconds")),
      );
      const controlDir = command.args?.[3];
      expect(controlDir).toMatch(/^\/tmp\/bigbud-tool-/);
      expect(command).toMatchObject({
        executionTargetId: binding.executionTargetId,
        cwd: binding.cwd,
        args: ["-c", SSH_OWNED_COMMAND, "bigbud-owned-tool", controlDir, "pwd"],
      });
      controller.abort();

      // Normal completion can also send this control command, so keep the SSH observer pending.
      const cancellation = await Effect.runPromise(
        Deferred.await(cancelled).pipe(Effect.timeout("2 seconds")),
      );
      expect(cancellation).toMatchObject({
        executionTargetId: binding.executionTargetId,
        command: "sh",
        args: ["-c", SSH_CANCEL_COMMAND, "bigbud-tool-control", controlDir],
      });
      const response = await Effect.runPromise(
        Effect.promise(() => pending).pipe(Effect.timeout("2 seconds")),
      );
      expect(response.status).toBe(499);
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined));
      setThreadOrchestrationToolDispatcher(null);
      try {
        await app.dispose();
      } finally {
        await resources.cleanup();
      }
    }
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
