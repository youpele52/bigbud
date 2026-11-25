import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { setThreadOrchestrationToolDispatcher } from "../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { prepareV2SharedCanonicalResources } from "../provider/Layers/OpencodeV2/Application.targets.auth.ts";
import { defaultThreadId, makeDefaultOrchestrationReadModel } from "../server.test.fixtures.ts";
import { runSshCommand } from "../ssh/sshProcess.ts";
import { deriveServerPaths, ServerConfig } from "../startup/config.ts";
import { threadOrchestrationToolsRouteLayer } from "./http.threadTools.ts";

vi.mock("../ssh/sshProcess.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ssh/sshProcess.ts")>()),
  runSshCommand: vi.fn(),
}));

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

// Exercise the route in memory with real token issuance and ownership, but no listener or SSH child.
async function withCallback(
  getReadModel: () => Effect.Effect<typeof model>,
  check: (fixture: {
    post: (remoteInvocationId?: string) => Promise<Response>;
    owner: NonNullable<
      Awaited<ReturnType<typeof prepareV2SharedCanonicalResources>>["remoteCommands"]
    >;
  }) => Promise<void>,
) {
  const baseDir = await mkdtemp(path.join(tmpdir(), "ssh-callback-baseline-"));
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
              getReadModel,
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
      const owner = resources.remoteCommands;
      if (!owner) throw new Error("Fixture requires a workspace execution owner.");
      await check({
        owner,
        post: (remoteInvocationId) =>
          app.handler(
            new Request("http://callback.invalid/api/internal/thread-tools", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-bigbud-thread-tool-token": resources.orchestration.token,
              },
              body: JSON.stringify({
                action: "remote_workspace_process",
                remoteInvocationId,
                remoteCommand: "pwd",
              }),
            }),
          ),
      });
    } finally {
      setThreadOrchestrationToolDispatcher(null);
      await app.dispose();
      await resources.cleanup();
    }
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  vi.mocked(runSshCommand).mockReset().mockResolvedValue({
    stdout: "/srv/fixture\n",
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
  });
});

it("rejects missing or malformed remote invocation IDs before resolving the workspace or calling SSH", async () => {
  const getReadModel = vi.fn(() => Effect.succeed(model));
  await withCallback(getReadModel, async ({ post }) => {
    for (const id of [undefined, "embedded space", "é", "x".repeat(257)]) {
      const response = await post(id);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        ok: false,
        message: "A stable remote tool invocation identity is required.",
      });
    }
    expect(getReadModel).not.toHaveBeenCalled();
    expect(runSshCommand).not.toHaveBeenCalled();
  });
});

it("refuses a callback held in workspace lookup across Stop and resume without any SSH call", async () => {
  const entered = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  const getReadModel = vi
    .fn(() => Effect.succeed(model))
    .mockReturnValueOnce(
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as(model),
      ),
    );
  await withCallback(getReadModel, async ({ owner, post }) => {
    const pending = post("previous-turn:0");
    try {
      await Effect.runPromise(Deferred.await(entered).pipe(Effect.timeout("2 seconds")));
      await owner.cancelActive();
      owner.resume();
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined));
    }
    const stale = await pending;
    expect(stale.status).toBe(502);
    expect(await stale.json()).toEqual({
      ok: false,
      message: "Remote turn was stopped before dispatch.",
    });
    expect(runSshCommand).not.toHaveBeenCalled();

    const fresh = await post("current-turn:0");
    expect(fresh.status).toBe(200);
    expect(runSshCommand).toHaveBeenCalledWith(
      expect.objectContaining({ executionTargetId: binding.executionTargetId, cwd: binding.cwd }),
    );
  });
});
