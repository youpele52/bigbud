import { Effect, Exit } from "effect";
import { expect, it, vi } from "vitest";
import { ThreadId, MessageId } from "@bigbud/contracts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { deferred, flushMicrotasks } from "./Test.fixtures.ts";
import { V2StartAttempt } from "./Runtime.start.ts";
import { makeIsolatedOpencodeV2Adapter } from "./Adapter.execution.ts";
import { makeV2LearningReview } from "./Runtime.learning.ts";

const threadId = ThreadId.makeUnsafe("teardown-owner");
const siblingId = ThreadId.makeUnsafe("teardown-sibling");
const modelSelection = {
  provider: "opencodeV2",
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
} as const;

for (const second of ["stop", "cancelStart"] as const) {
  it(`joins exact-owner teardown for concurrent ${second} and propagates its failure`, async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
      const attempt = new V2StartAttempt();
      await runtime.start(
        { threadId, cwd: directory, modelSelection, runtimeMode: "approval-required" },
        attempt,
      );
      const gate = deferred<void>();
      const entered = deferred<void>();
      const interrupt = vi
        .spyOn(http.client.session, "interrupt")
        .mockImplementationOnce(async () => {
          entered.resolve();
          await gate.promise;
          throw new Error("synthetic cleanup failure");
        });
      const first = runtime.stop(threadId).then(
        () => "success",
        () => "failure",
      );
      await entered.promise;
      let done = false;
      const joined = (
        second === "stop" ? runtime.stop(threadId) : runtime.cancelStart(attempt)
      ).then(
        () => {
          done = true;
          return "success";
        },
        () => {
          done = true;
          return "failure";
        },
      );
      await flushMicrotasks();
      const premature = done;
      gate.resolve();
      expect(await first).toBe("failure");
      expect(await joined).toBe("failure");
      expect(premature).toBe(false);
      expect(interrupt).toHaveBeenCalledTimes(1);
    });
  });
}

it("quarantines an abort-ignoring native interrupt beyond its deadline while sibling leases keep the process alive", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const discovery = await runtime.options.manager.acquire(runtime.options.config);
    const attempt = new V2StartAttempt();
    const start = {
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required" as const,
    };
    await runtime.start(start, attempt);
    const nativeId = runtime.get(threadId).native.id;
    await runtime.start({ ...start, threadId: siblingId });
    Object.assign(runtime.options, { maxSessions: 2 });
    const gate = deferred<void>();
    const entered = deferred<void>();
    const original = http.client.session.interrupt;
    const interrupt = vi
      .spyOn(http.client.session, "interrupt")
      .mockImplementationOnce(async (...args) => {
        entered.resolve();
        await gate.promise;
        return original(...args);
      });
    vi.useFakeTimers();
    const stop = runtime.stop(threadId).then(
      () => "success",
      () => "failure",
    );
    await entered.promise;
    try {
      await vi.advanceTimersByTimeAsync(10001);
    } finally {
      vi.useRealTimers();
    }
    expect(await stop).toBe("failure");
    expect(http.running).toBe(true);
    const blocked = await runtime.start(start).then(
      () => false,
      () => true,
    );
    // Always release the synthetic held request, including on a failed regression assertion.
    try {
      expect(blocked).toBe(true);
      expect(runtime.teardown.capacity()).toBe(2);
      await expect(
        runtime.start({ ...start, threadId: ThreadId.makeUnsafe("over-quarantine-capacity") }),
      ).rejects.toThrow("capacity");
      await expect(runtime.cancelStart(attempt)).rejects.toThrow();
      await runtime.send({
        threadId: siblingId,
        requestMessageId: MessageId.makeUnsafe("teardown-sibling-input"),
        input: "synthetic sibling",
        modelSelection,
      });
      expect(
        http.calls.filter(
          (call) => call.pathname.endsWith("/prompt") && call.pathname.includes(nativeId),
        ),
      ).toHaveLength(0);
      expect(
        events.filter((event) => event.threadId === threadId && event.type === "session.exited"),
      ).toHaveLength(0);
    } finally {
      gate.resolve();
      await flushMicrotasks();
    }
    if (blocked) {
      await runtime.start(start);
      const successor = runtime.get(threadId);
      await runtime.cancelStart(attempt);
      expect(runtime.get(threadId)).toBe(successor);
      expect(successor.stopped).toBe(false);
    }
    expect(interrupt.mock.calls.filter((call) => call[0].sessionID === nativeId)).toHaveLength(1);
    await discovery.release();
  });
});

for (const operation of ["stopAll", "finalizer"] as const) {
  it(`exposes native cleanup failure through adapter ${operation} instead of ignoring it`, async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { adapter } = yield* makeIsolatedOpencodeV2Adapter(runtime.options);
            yield* adapter.startSession({
              threadId,
              cwd: directory,
              modelSelection,
              runtimeMode: "approval-required",
            });
            vi.spyOn(http.client.session, "interrupt").mockImplementationOnce(async () => {
              throw new Error("synthetic teardown rejection");
            });
            if (operation === "stopAll") yield* adapter.stopAll();
          }),
        ).pipe(Effect.exit),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(http.running).toBe(false);
    });
  });
}

it("fails a completed learning review when exact-owner cleanup fails", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    vi.spyOn(http.client.session, "interrupt").mockImplementationOnce(async () => {
      throw new Error("synthetic learning cleanup rejection");
    });
    const result = await Effect.runPromise(
      makeV2LearningReview(runtime)({
        ownerThreadId: threadId,
        jobId: "cleanup-failed",
        cwd: directory,
        modelSelection,
        input: "synthetic review",
      }).pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    expect(runtime.sessions.size).toBe(0);
    expect(http.running).toBe(false);
  });
});

it("releases an uncertain binding quarantine on owned process-generation death, not merely a timeout", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const discovery = await runtime.options.manager.acquire(runtime.options.config);
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const gate = deferred<void>();
    const entered = deferred<void>();
    vi.spyOn(http.client.session, "interrupt").mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
      return { interrupted: true };
    });
    vi.useFakeTimers();
    const stopped = runtime.stop(threadId).then(
      () => "success",
      () => "failure",
    );
    await entered.promise;
    try {
      await vi.advanceTimersByTimeAsync(10001);
    } finally {
      vi.useRealTimers();
    }
    expect(await stopped).toBe("failure");
    expect(runtime.teardown.has(threadId)).toBe(true);
    http.die();
    expect(runtime.teardown.has(threadId)).toBe(false);
    expect(runtime.teardown.capacity()).toBe(0);
    gate.resolve();
    await flushMicrotasks();
    await discovery.release();
  });
});

it("bounded shutdown joins a quarantined failure and closes its owned generation even with a discovery lease", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const discovery = await runtime.options.manager.acquire(runtime.options.config);
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const gate = deferred<void>();
    const entered = deferred<void>();
    vi.spyOn(http.client.session, "interrupt").mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
      return { interrupted: true };
    });
    vi.useFakeTimers();
    const stop = runtime.stop(threadId).then(
      () => "success",
      () => "failure",
    );
    await entered.promise;
    try {
      await vi.advanceTimersByTimeAsync(10001);
    } finally {
      vi.useRealTimers();
    }
    expect(await stop).toBe("failure");
    const started = Date.now();
    const close = await runtime.close().then(
      () => "success",
      () => "failure",
    );
    expect(close).toBe("failure");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(http.running).toBe(false);
    expect(runtime.teardown.capacity()).toBe(0);
    gate.resolve();
    await flushMicrotasks();
    await discovery.release();
  });
});

it("does not treat a transport rejecting on deadline abort as authoritative native cancellation", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const discovery = await runtime.options.manager.acquire(runtime.options.config);
    const start = {
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required" as const,
    };
    await runtime.start(start);
    const entered = deferred<void>();
    vi.spyOn(http.client.session, "interrupt").mockImplementationOnce(
      (_input, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("synthetic transport cancelled; native outcome unknown")),
            { once: true },
          );
          entered.resolve();
        }),
    );
    vi.useFakeTimers();
    const stop = runtime.stop(threadId).then(
      () => "success",
      () => "failure",
    );
    await entered.promise;
    try {
      await vi.advanceTimersByTimeAsync(10001);
    } finally {
      vi.useRealTimers();
    }
    expect(await stop).toBe("failure");
    const blocked = await runtime.start(start).then(
      () => false,
      () => true,
    );
    http.die();
    await discovery.release();
    expect(blocked).toBe(true);
  });
});

it("does not discharge quarantine from a logical not-running flag before actual generation exit", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const discovery = await runtime.options.manager.acquire(runtime.options.config);
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const process = runtime.get(threadId).lease.process;
    Object.assign(process, { hasExited: () => !http.running });
    const gate = deferred<void>();
    const entered = deferred<void>();
    vi.spyOn(http.client.session, "interrupt").mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
      return { interrupted: true };
    });
    vi.useFakeTimers();
    const stopped = runtime.stop(threadId).then(
      () => "success",
      () => "failure",
    );
    await entered.promise;
    try {
      await vi.advanceTimersByTimeAsync(10001);
    } finally {
      vi.useRealTimers();
    }
    expect(await stopped).toBe("failure");
    const health = vi.spyOn(process, "isRunning").mockReturnValue(false);
    const quarantined = runtime.teardown.has(threadId);
    health.mockRestore();
    gate.resolve();
    await flushMicrotasks();
    await discovery.release();
    expect(quarantined).toBe(true);
  });
});
