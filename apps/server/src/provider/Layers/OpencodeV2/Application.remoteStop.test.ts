import { Effect } from "effect";
import { MessageId } from "@bigbud/contracts/core/baseSchemas.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withWorkspaceApp, threadId, workspaceModel } from "./Application.workspace.fixture.ts";
import { deferred } from "./Test.fixtures.ts";
import { readThreadOrchestrationToolAuthByToken } from "../../../orchestration-tools/ThreadOrchestrationToolAuth.ts";
import { runRemoteWorkspaceProcess } from "../../../ws/http.threadTools.remoteWorkspace.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { runToolCommand } from "../../../tool-transport/toolTransport.ts";
import { withCommandCancellation } from "../../../utils/commandCancellation.ts";

vi.mock("../../../remote-workspace-bridge/remoteWorkspaceReadiness.ts", () => ({
  probeRemoteWorkspaceReadiness: async () => ({ os: "linux", architecture: "x86_64" }),
}));
vi.mock("../../../tool-transport/toolTransport.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../tool-transport/toolTransport.ts")>()),
  runToolCommand: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(runToolCommand).mockReset();
});
afterEach(() => vi.restoreAllMocks());

it.each(["interrupt", "stopSession"] as const)(
  "%s cancels VPS work outside the native queue and joins physical termination",
  async (action) => {
    await withWorkspaceApp(true, async (h) => {
      await h.send("first");
      const owner = h.runtime.get(threadId);
      const commands = owner.resources!.remoteCommands!;
      const record = await readThreadOrchestrationToolAuthByToken({
        stateDir: h.services.serverConfig.stateDir,
        token: owner.resources!.orchestration!.token,
      });
      const entered = deferred<void>();
      const cancelled = deferred<void>();
      const terminal = deferred<void>();
      const queueEntered = deferred<void>();
      const queueReleased = deferred<void>();
      vi.mocked(runToolCommand).mockImplementation(({ signal }) =>
        withCommandCancellation(
          signal,
          () => {
            entered.resolve();
            return new Promise(() => {});
          },
          async () => {
            cancelled.resolve();
            await terminal.promise;
          },
        ),
      );
      const call = (id: string) =>
        Effect.runPromise(
          runRemoteWorkspaceProcess({
            callerThreadId: threadId,
            workspaceBinding: record!.workspaceBinding,
            executionOwner: commands,
            request: { remoteInvocationId: id, remoteCommand: "sleep", remoteArgs: ["60"] },
          }).pipe(
            Effect.provideService(
              OrchestrationEngineService,
              h.services.orchestrationEngine as never,
            ),
          ),
        );
      const running = call("old-tool:0");
      const rejected = expect(running).rejects.toThrow("cancelled");
      await entered.promise;
      const held = h.runtime.withSession(threadId, async () => {
        queueEntered.resolve();
        await queueReleased.promise;
      });
      await queueEntered.promise;
      let finished = false;
      const stopping = Effect.runPromise(
        action === "interrupt"
          ? h.provider.interruptTurn({ threadId })
          : h.provider.stopSession({ threadId }),
      ).then(() => {
        finished = true;
      });
      try {
        await cancelled.promise;
        expect(finished).toBe(false);
        await expect(call("late-tool:0")).rejects.toThrow("stopped");
        queueReleased.resolve();
        await held;
        expect(finished).toBe(false);
        terminal.resolve();
        await rejected;
        await stopping;
        expect(commands.busyCount()).toBe(0);
        if (action === "interrupt") {
          await h.send("second");
          expect(h.runtime.get(threadId)).toBe(owner);
          await expect(call("old-tool:1")).rejects.toThrow("stopped");
          vi.mocked(runToolCommand).mockResolvedValue({
            stdout: "ok",
            stderr: "",
            code: 0,
            signal: null,
            timedOut: false,
          });
          await expect(call("new-tool:0")).resolves.toMatchObject({ stdout: "ok" });
        }
      } finally {
        queueReleased.resolve();
        terminal.resolve();
        await Promise.allSettled([held, running, stopping]);
      }
    });
  },
);

it("a turn already queued when Stop arrives cannot reopen remote tools or dispatch a prompt", async () => {
  await withWorkspaceApp(true, async (h) => {
    await h.send("first");
    const entered = deferred<void>();
    const release = deferred<void>();
    const held = h.runtime.withSession(threadId, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const sending = h.runtime.send({
      threadId,
      requestMessageId: MessageId.makeUnsafe("queued-before-stop"),
      modelSelection: workspaceModel,
      input: "must not run",
    });
    const observed = sending.catch((cause: unknown) => cause);
    const stopped = h.runtime.interrupt(threadId);
    release.resolve();
    await held;
    expect(String(await observed)).toContain("stopped before dispatch");
    await stopped;
    expect(h.prompts()).toHaveLength(1);
    await h.send("after-stop");
    expect(h.prompts()).toHaveLength(2);
  });
});

it("an HTTP invocation awaiting workspace metadata stays cancelled after the next prompt resumes tools", async () => {
  await withWorkspaceApp(true, async (h) => {
    await h.send("first");
    const owner = h.runtime.get(threadId);
    const entered = deferred<void>();
    const release = deferred<void>();
    const engine = h.services.orchestrationEngine;
    const read = engine.getReadModel();
    vi.spyOn(engine, "getReadModel").mockReturnValueOnce(
      Effect.promise(async () => {
        entered.resolve();
        await release.promise;
      }).pipe(Effect.andThen(read)),
    );
    const running = Effect.runPromise(
      runRemoteWorkspaceProcess({
        callerThreadId: threadId,
        workspaceBinding: { executionTargetId: h.target, cwd: h.cwd },
        executionOwner: owner.resources!.remoteCommands!,
        request: { remoteInvocationId: "delayed-http:0", remoteCommand: "touch" },
      }).pipe(Effect.provideService(OrchestrationEngineService, engine as never)),
    );
    const observed = running.catch((cause: unknown) => cause);
    try {
      await entered.promise;
      await h.runtime.interrupt(threadId);
      await h.send("second");
      release.resolve();
      expect(String(await observed)).toContain("stopped before dispatch");
      expect(runToolCommand).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await observed;
    }
  });
});
