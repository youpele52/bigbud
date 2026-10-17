import { Effect, Fiber } from "effect";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { expect, it, vi } from "vitest";
import {
  withV2FacadeCancellationFixture,
  type V2FacadeSyntheticWire,
} from "./Application.facade.cancellation.fixture.ts";
import { deferred } from "./Test.fixtures.ts";

const wire = vi.hoisted(() => ({}) as V2FacadeSyntheticWire);

it("a live production-facade request still creates its exact owned history and dispatches one prompt", async () => {
  await withV2FacadeCancellationFixture(wire, async (f) => {
    const threadId = ThreadId.makeUnsafe("live-production-control"),
      requestMessageId = MessageId.makeUnsafe("live-production-control-input");
    await Effect.runPromise(
      f.registration.adapterService.startSession({
        threadId,
        cwd: f.directory,
        runtimeMode: "full-access",
        modelSelection: {
          provider: "opencodeV2",
          subProviderID: "synthetic-provider",
          model: "synthetic-model",
        },
      }),
    );
    await Effect.runPromise(
      f.registration.adapterService.sendTurn({
        threadId,
        requestMessageId,
        input: "synthetic live control",
      }),
    );
    expect(f.http.sessions.size).toBe(1);
    expect(f.http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
    expect(
      await Effect.runPromise(
        f.base.options.journal.find({
          namespace: "foreground",
          ownerThreadId: threadId,
          requestMessageId,
        }),
      ),
    ).toMatchObject({ state: "terminal" });
  });
});
vi.mock("./Application.shared.ts", () => ({
  readV2SharedApplicationConfig: async () => ({
    workspace: wire.workspace,
    process: { runtimeTargetId: "local", sharedService: wire.descriptor },
  }),
}));
vi.mock("./SharedService.connection.ts", () => ({
  borrowV2SharedService: async () => ({
    ownership: "borrowed",
    client: wire.client,
    isRunning: () => true,
    hasExited: () => false,
    onDeath: () => () => {},
    close: async () => {},
  }),
}));
vi.mock("./Catalog.public.ts", async (original) => ({
  ...(await original<typeof import("./Catalog.public.ts")>()),
  makeV2PublicCatalogLoader: () => async () => ({ models: [], stale: false }),
}));

it.each(["start", "send"] as const)(
  "interrupting production registration.adapterService.%s during setup cannot later admit the cancelled request",
  async (kind) => {
    await withV2FacadeCancellationFixture(wire, async (f) => {
      const threadId = ThreadId.makeUnsafe(`cancel-production-${kind}`),
        requestMessageId = MessageId.makeUnsafe(`cancel-production-${kind}-input`);
      const input = {
        threadId,
        cwd: f.directory,
        runtimeMode: "full-access" as const,
        modelSelection: {
          provider: "opencodeV2" as const,
          subProviderID: "synthetic-provider",
          model: "synthetic-model",
        },
      };
      if (kind === "send")
        await Effect.runPromise(f.registration.adapterService.startSession(input)).catch(
          (error) => {
            throw new Error(wire.failure ?? String(error));
          },
        );
      const before = JSON.stringify([...f.http.sessions.values()]);
      f.pause();
      const other = await f.keeper();
      const operation =
        kind === "start"
          ? f.registration.adapterService.startSession(input).pipe(Effect.asVoid)
          : f.registration.adapterService
              .sendTurn({
                threadId,
                input: "must never submit",
                requestMessageId,
              })
              .pipe(Effect.asVoid);
      const fiber = Effect.runFork(operation);
      await f.entered;
      // The keeper entered first; wait for the real production caller's second interest.
      await expect
        .poll(
          () =>
            (
              f.coordinator.jobs as unknown as {
                jobs: Map<string, { interests: Map<string, unknown> }>;
              }
            ).jobs.get(other.handle.jobId)?.interests.size,
        )
        .toBe(2);
      await Effect.runPromise(Fiber.interrupt(fiber));
      f.release();
      expect(await f.coordinator.jobs.wait(other.handle, other.scope)).toMatchObject({
        state: "ready",
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(f.http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
      expect(JSON.stringify([...f.http.sessions.values()])).toBe(before);
      expect(
        await Effect.runPromise(
          f.base.options.journal.find({
            namespace: "foreground",
            ownerThreadId: threadId,
            requestMessageId,
          }),
        ),
      ).toBeUndefined();
      if (kind === "start")
        expect(
          await Effect.runPromise(f.base.options.sharedBindings!.find(threadId)),
        ).toBeUndefined();
    });
  },
);

it("the production facade preserves normal 30-second startup deferral as setup-only continuation", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    await withV2FacadeCancellationFixture(wire, async (f) => {
      f.pause();
      const other = await f.keeper(),
        entered = deferred<void>();
      const wait = f.coordinator.jobs.wait.bind(f.coordinator.jobs);
      const observation = vi.spyOn(f.coordinator.jobs, "wait").mockImplementation((...args) => {
        if (args[0].interestId !== other.handle.interestId) entered.resolve();
        return wait(...args);
      });
      try {
        const threadId = ThreadId.makeUnsafe("production-normal-deferral"),
          start = Effect.runPromise(
            Effect.exit(
              f.registration.adapterService.startSession({
                threadId,
                cwd: f.directory,
                runtimeMode: "full-access",
                modelSelection: {
                  provider: "opencodeV2",
                  subProviderID: "synthetic-provider",
                  model: "synthetic-model",
                },
              }),
            ),
          );
        await entered.promise;
        await vi.advanceTimersByTimeAsync(30000);
        expect((await start)._tag).toBe("Failure");
        expect(f.job().signal.aborted).toBe(false);
        expect(f.http.sessions.size).toBe(0);
        expect(
          await Effect.runPromise(f.base.options.sharedBindings!.find(threadId)),
        ).toBeUndefined();
        f.release();
        expect(await wait(other.handle, other.scope)).toMatchObject({ state: "ready" });
        expect(f.http.sessions.size).toBe(0);
        expect(f.http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
      } finally {
        observation.mockRestore();
        f.release();
      }
    });
  } finally {
    vi.useRealTimers();
  }
});

it("production facade cancellation after ready but during the final model read issues no journal reservation", async () => {
  await withV2FacadeCancellationFixture(wire, async (f) => {
    const threadId = ThreadId.makeUnsafe("production-final-model-cancel"),
      requestMessageId = MessageId.makeUnsafe("production-final-model-cancel-input");
    await Effect.runPromise(
      f.registration.adapterService.startSession({
        threadId,
        cwd: f.directory,
        runtimeMode: "full-access",
        modelSelection: {
          provider: "opencodeV2",
          subProviderID: "synthetic-provider",
          model: "synthetic-model",
        },
      }),
    );
    await Effect.runPromise(f.registration.providerService.refresh);
    const held = deferred<void>(),
      entered = deferred<void>(),
      model = f.http.client.model.list,
      before = JSON.stringify([...f.http.sessions.values()]),
      reserve = vi.spyOn(f.base.options.journal, "reserve");
    const delayed = vi.spyOn(f.http.client.model, "list").mockImplementation(async (...args) => {
      const response = await model(...args);
      entered.resolve();
      await held.promise;
      return response;
    });
    try {
      const fiber = Effect.runFork(
        f.registration.adapterService.sendTurn({
          threadId,
          input: "never reserve",
          requestMessageId,
        }),
      );
      await entered.promise;
      await Effect.runPromise(Fiber.interrupt(fiber));
      held.resolve();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(reserve).not.toHaveBeenCalled();
      expect(
        await Effect.runPromise(
          f.base.options.journal.find({
            namespace: "foreground",
            ownerThreadId: threadId,
            requestMessageId,
          }),
        ),
      ).toBeUndefined();
      expect(JSON.stringify([...f.http.sessions.values()])).toBe(before);
      expect(f.http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
    } finally {
      held.resolve();
      delayed.mockRestore();
      reserve.mockRestore();
    }
  });
});
