import { clearReplacedMobileSessionCaches } from "./mobileRecovery.session";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { describe, expect, it, vi } from "vitest";
import { createMobileRecoveryController } from "./mobileRecovery.controller";
import {
  makeBaseline,
  makeClient,
  makeFrame,
  makeQueryClient,
  makeScheduler,
  makeStreamHarness,
  settle,
} from "./mobileRecovery.test.utils";

describe("mobile session replacement", () => {
  it("clears caches only for session/backend replacement or unpairing", () => {
    const queryClient = { removeQueries: vi.fn() };
    const previous = { sessionId: "session", backendBaseUrl: "https://one.example" };
    clearReplacedMobileSessionCaches(queryClient, previous, { ...previous });
    expect(queryClient.removeQueries).not.toHaveBeenCalled();
    for (const next of [
      null,
      { ...previous, sessionId: "new" },
      { ...previous, backendBaseUrl: "https://two.example" },
    ]) {
      clearReplacedMobileSessionCaches(queryClient, previous, next);
    }
    expect(queryClient.removeQueries).toHaveBeenCalledTimes(6);
    expect(queryClient.removeQueries).toHaveBeenCalledWith({
      queryKey: ["mobile-snapshot", "session"],
    });
    expect(queryClient.removeQueries).toHaveBeenCalledWith({
      queryKey: ["mobile-thread", "session"],
    });
  });

  it("preserves a direct route selection made before the provider start effect", async () => {
    const stream = makeStreamHarness();
    const controller = createMobileRecoveryController({
      client: makeClient({
        stream,
        readBaseline: async ({ recoveryAttemptId }) =>
          makeBaseline(recoveryAttemptId, 1, { status: "missing" }),
      }),
      queryClient: makeQueryClient(),
      sessionId: "direct-route",
      scheduler: makeScheduler(),
    });
    const selected = controller.selectThread(ThreadId.makeUnsafe("selected-before-start"));
    controller.start();
    await selected;
    expect(controller.getState().selectedThreadId).toBe("selected-before-start");
    expect(stream.runs).toHaveLength(1);
    controller.dispose();
  });

  it("fences late baseline and stream callbacks from a disposed session", async () => {
    const queryClient = makeQueryClient();
    const oldStream = makeStreamHarness();
    const oldController = createMobileRecoveryController({
      client: makeClient({
        stream: oldStream,
        readBaseline: async ({ recoveryAttemptId }) => makeBaseline(recoveryAttemptId, 1),
      }),
      queryClient,
      sessionId: "old-session",
      scheduler: makeScheduler(),
    });
    oldController.start();
    await settle();
    let resolveOld: (value: ReturnType<typeof makeBaseline>) => void = () => {};
    const oldClient = makeClient({
      stream: makeStreamHarness(),
      readBaseline: () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    });
    const pendingController = createMobileRecoveryController({
      client: oldClient,
      queryClient,
      sessionId: "pending-old-session",
      scheduler: makeScheduler(),
      makeAttemptId: () => "pending-old",
    });
    pendingController.start();
    oldController.dispose();
    pendingController.dispose();
    queryClient.removeQueries({ queryKey: ["mobile-snapshot", "old-session"] });

    const stream = makeStreamHarness();
    const replacement = createMobileRecoveryController({
      client: makeClient({
        stream,
        readBaseline: async ({ recoveryAttemptId }) => makeBaseline(recoveryAttemptId, 10),
      }),
      queryClient,
      sessionId: "replacement",
      scheduler: makeScheduler(),
    });
    replacement.start();
    await settle();
    const run = stream.runs[0]!;
    stream.dispatch(makeFrame(run.recoveryAttemptId, { type: "caught-up", throughSequence: 10 }));
    const oldRun = oldStream.runs[0]!;
    oldRun.dispatchFrame(
      makeFrame(oldRun.recoveryAttemptId, { type: "caught-up", throughSequence: 1 }),
    );
    resolveOld(makeBaseline("pending-old", 99));
    await settle();
    expect(replacement.getState()).toMatchObject({ freshness: "current", throughSequence: 10 });
    expect(queryClient.getQueryData(["mobile-snapshot", "old-session"])).toBeUndefined();
    expect(queryClient.getQueryData(["mobile-snapshot", "pending-old-session"])).toBeUndefined();
    expect(queryClient.getQueryData(["mobile-snapshot", "replacement"])).toEqual(
      makeBaseline("unused", 10).snapshot,
    );
    replacement.dispose();
  });
});
