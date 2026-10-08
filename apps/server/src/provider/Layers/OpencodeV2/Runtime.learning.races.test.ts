import { Effect, Fiber } from "effect";
import { expect, it, vi } from "vitest";
import { ThreadId } from "@bigbud/contracts";
import { makeV2LearningReview } from "./Runtime.learning.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { deferred } from "./Test.fixtures.ts";
import { makeIsolatedOpencodeV2Adapter } from "./Adapter.execution.ts";
import { V2StartAttempt } from "./Runtime.start.ts";

const modelSelection = {
  provider: "opencodeV2",
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
} as const;
const ownerThreadId = ThreadId.makeUnsafe("learning-race-owner");

it("late cleanup of a cancelled installed attempt cannot remove a successor owning the same durable thread", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const retained = await runtime.options.manager.acquire(runtime.options.config);
    const recovery = deferred<void>();
    const recoveryEntered = deferred<void>();
    vi.spyOn(runtime.options.journal, "listBoundPage").mockImplementationOnce(() =>
      Effect.promise(async () => {
        recoveryEntered.resolve();
        await recovery.promise;
        return [];
      }),
    );
    const cleanup = deferred<void>();
    const cleanupEntered = deferred<void>();
    const interrupt = http.client.session.interrupt;
    vi.spyOn(http.client.session, "interrupt").mockImplementationOnce(async (...args) => {
      cleanupEntered.resolve();
      await cleanup.promise;
      return interrupt(...args);
    });
    const attempt = new V2StartAttempt();
    const start = runtime.start(
      { threadId: ownerThreadId, cwd: directory, modelSelection, runtimeMode: "approval-required" },
      attempt,
    );
    const rejected = expect(start).rejects.toThrow();
    await recoveryEntered.promise;
    const cancelled = runtime.cancelStart(attempt);
    recovery.resolve();
    await rejected;
    await cleanupEntered.promise;
    // A delayed native interrupt still targets this durable native ID. Rebinding before
    // it settles would expose a successor's generation to the old cleanup request.
    const blocked = await runtime
      .start({
        threadId: ownerThreadId,
        cwd: directory,
        modelSelection,
        runtimeMode: "approval-required",
      })
      .then(
        () => false,
        () => true,
      );
    cleanup.resolve();
    await cancelled;
    expect(blocked).toBe(true);
    await runtime.start({
      threadId: ownerThreadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const successor = runtime.get(ownerThreadId);
    await runtime.cancelStart(attempt);
    expect(runtime.sessions.get(ownerThreadId)).toBe(successor);
    expect(successor.stopped).toBe(false);
    expect(events.filter((event) => event.type === "session.exited")).toHaveLength(1);
    await retained.release();
  });
});

it("rejects an overlapping same-job review without stopping the successfully acquired winner", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    http.autoComplete = false;
    const review = makeV2LearningReview(runtime);
    const request = {
      ownerThreadId,
      jobId: "overlap",
      cwd: directory,
      modelSelection,
      input: "held model review",
    };
    const first = Effect.runPromise(review(request));
    void first.catch(() => {});
    await expect
      .poll(() => http.calls.filter((call) => call.pathname.endsWith("/prompt")).length)
      .toBe(1);
    const session = [...runtime.sessions.values()][0]!;
    const loser = await Effect.runPromise(review(request).pipe(Effect.result));
    expect(loser._tag).toBe("Failure");
    expect(session.stopped).toBe(false);
    expect(runtime.sessions.get(session.threadId)).toBe(session);
    http.complete(session.native.id);
    expect(await first).toBe("authoritative full output");
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
    expect(runtime.sessions.size).toBe(0);
  });
});

for (const phase of ["acquire", "create"] as const) {
  it(`fences cancelled learning startup held at ${phase} and disposes its late lease without touching another owner`, async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
      const gate = deferred<void>();
      const entered = deferred<void>();
      await runtime.start({
        threadId: ownerThreadId,
        cwd: directory,
        modelSelection,
        runtimeMode: "approval-required",
      });
      if (phase === "acquire") {
        const acquire = runtime.options.manager.acquire.bind(runtime.options.manager);
        vi.spyOn(runtime.options.manager, "acquire").mockImplementationOnce(async (config) => {
          const lease = await acquire(config);
          entered.resolve();
          await gate.promise;
          return lease;
        });
      } else {
        const create = http.client.session.create;
        vi.spyOn(http.client.session, "create").mockImplementationOnce(async (...args) => {
          entered.resolve();
          await gate.promise;
          return create(...args);
        });
      }
      const review = makeV2LearningReview(runtime);
      const fiber = Effect.runFork(
        review({
          ownerThreadId,
          jobId: phase,
          cwd: directory,
          modelSelection,
          input: "cancel before dispatch",
        }),
      );
      await entered.promise;
      await Effect.runPromise(Fiber.interrupt(fiber));
      gate.resolve();
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect([...runtime.sessions.keys()]).toEqual([ownerThreadId]);
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
      expect(runtime.get(ownerThreadId).stopped).toBe(false);
      await runtime.stop(ownerThreadId);
      await expect.poll(() => http.running).toBe(false);
    });
  });
}

it("cancels foreground acquisition through the real adapter and closes finitely when create ignores abort forever", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const entered = deferred<void>();
    vi.spyOn(http.client.session, "create").mockImplementationOnce(() => {
      entered.resolve();
      return new Promise(() => {});
    });
    const start = Date.now();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { adapter, runtime: owned } = yield* makeIsolatedOpencodeV2Adapter(runtime.options);
          const fiber = yield* adapter
            .startSession({
              threadId: ownerThreadId,
              cwd: directory,
              modelSelection,
              runtimeMode: "approval-required",
            })
            .pipe(Effect.forkScoped);
          yield* Effect.promise(() => entered.promise);
          yield* Fiber.interrupt(fiber);
          yield* Effect.promise(async () => {
            await expect.poll(() => http.running).toBe(false);
            expect(owned.sessions.size).toBe(0);
            expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
          });
        }),
      ),
    );
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
