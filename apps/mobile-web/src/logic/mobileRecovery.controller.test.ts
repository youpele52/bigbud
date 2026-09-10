import { MobileRecoveryUnsupportedError } from "../lib/mobileRpc.errors";
import type { MobileRecoveryBaseline } from "@bigbud/contracts/server/mobile.recovery";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { OrchestrationReadModel } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import { createMobileRecoveryController } from "./mobileRecovery.controller";
import {
  makeBaseline,
  makeEvent,
  makeFrame,
  makeSnapshot,
  makeQueryClient,
  makeStreamHarness,
  makeScheduler,
  makeClient,
  serverEpoch,
  sessionId,
  settle,
} from "./mobileRecovery.test.utils";

describe("mobile recovery controller", () => {
  it("accepts a zero-event caught-up marker as current", async () => {
    const stream = makeStreamHarness();
    const queryClient = makeQueryClient();
    const client = makeClient({
      readBaseline: async ({ recoveryAttemptId }) => makeBaseline(recoveryAttemptId, 7),
      stream,
    });
    const controller = createMobileRecoveryController({
      client: client as never,
      queryClient,
      sessionId,
      scheduler: makeScheduler(),
      makeAttemptId: () => "attempt-1",
    });

    controller.start();
    await settle();
    expect(stream.runs[0]?.serverEpoch).toBe(serverEpoch);
    stream.dispatch(makeFrame("attempt-1", { type: "caught-up", throughSequence: 7 }));

    expect(controller.getState()).toMatchObject({
      freshness: "current",
      snapshotSequence: 7,
      throughSequence: 7,
      actionsAvailable: true,
    });
    expect(queryClient.getQueryData(["mobile-snapshot", sessionId])).toEqual(makeSnapshot(7));
    controller.dispose();
  });

  it("keeps freshness stale when a marker does not cover queued events", async () => {
    const stream = makeStreamHarness();
    const queryClient = makeQueryClient();
    const client = makeClient({
      readBaseline: async ({ recoveryAttemptId }) => makeBaseline(recoveryAttemptId, 7),
      stream,
    });
    const controller = createMobileRecoveryController({
      client: client as never,
      queryClient,
      sessionId,
      scheduler: makeScheduler(),
      makeAttemptId: () => "attempt-1",
    });

    controller.start();
    await settle();
    stream.dispatch(makeFrame("attempt-1", { type: "caught-up", throughSequence: 6 }));

    expect(controller.getState()).toMatchObject({
      freshness: "stale",
      actionsAvailable: false,
      reason: "caught-up-sequence-mismatch",
    });
    controller.dispose();
  });

  it("fences a delayed baseline from an earlier selected-thread generation", async () => {
    const stream = makeStreamHarness();
    const queryClient = makeQueryClient();
    const pending = new Map<string, (baseline: MobileRecoveryBaseline) => void>();
    const client = makeClient({
      readBaseline: ({ recoveryAttemptId }) =>
        new Promise((resolve) => pending.set(recoveryAttemptId, resolve)),
      stream,
    });
    let attempt = 0;
    const controller = createMobileRecoveryController({
      client: client as never,
      queryClient,
      sessionId,
      scheduler: makeScheduler(),
      makeAttemptId: () => `attempt-${++attempt}`,
    });

    controller.start();
    await settle();
    const nextSelection = controller.selectThread(ThreadId.makeUnsafe("thread-2"));
    await settle();
    pending.get("attempt-2")?.(makeBaseline("attempt-2", 12, { status: "missing" }));
    await settle();
    stream.dispatch(makeFrame("attempt-2", { type: "caught-up", throughSequence: 12 }));
    expect(controller.getState()).toMatchObject({
      freshness: "current",
      selectedThreadId: ThreadId.makeUnsafe("thread-2"),
      selectedThreadStatus: "missing",
    });
    pending.get("attempt-1")?.(makeBaseline("attempt-1", 3));
    await settle();
    await nextSelection;

    expect(
      queryClient.getQueryData<OrchestrationReadModel>(["mobile-snapshot", sessionId]),
    ).toMatchObject({
      snapshotSequence: 12,
    });
    expect(controller.getState().snapshotSequence).toBe(12);
    controller.dispose();
  });

  it("ignores frames from an older recovery attempt after a refresh", async () => {
    const stream = makeStreamHarness();
    const queryClient = makeQueryClient();
    let attempt = 0;
    const client = makeClient({
      readBaseline: async ({ recoveryAttemptId }) =>
        makeBaseline(recoveryAttemptId, recoveryAttemptId === "attempt-1" ? 1 : 2),
      stream,
    });
    const controller = createMobileRecoveryController({
      client: client as never,
      queryClient,
      sessionId,
      scheduler: makeScheduler(),
      makeAttemptId: () => `attempt-${++attempt}`,
    });

    controller.start();
    await settle();
    stream.dispatch(makeFrame("attempt-1", { type: "caught-up", throughSequence: 1 }));
    const refresh = controller.refresh(null);
    await settle();

    stream.runs[0]?.dispatchFrame(
      makeFrame("attempt-1", { type: "caught-up", throughSequence: 99 }),
    );
    expect(controller.getState()).toMatchObject({
      freshness: "refreshing",
      snapshotSequence: 2,
    });
    stream.dispatch(makeFrame("attempt-2", { type: "caught-up", throughSequence: 2 }));
    await refresh;
    expect(controller.getState().freshness).toBe("current");
    controller.dispose();
  });

  it("does not treat synchronous cancellation of the prior stream as a failure", async () => {
    const runs: Array<{
      readonly recoveryAttemptId: string;
      readonly dispatchFrame: (frame: ReturnType<typeof makeFrame>) => void;
      readonly onExit: () => void;
    }> = [];
    let current:
      | {
          readonly recoveryAttemptId: string;
          readonly dispatchFrame: (frame: ReturnType<typeof makeFrame>) => void;
          readonly onExit: () => void;
        }
      | undefined;
    const stream = {
      startStream(input: (typeof runs)[number]) {
        current = input;
        runs.push(input);
        return () => input.onExit();
      },
      dispatch(frame: ReturnType<typeof makeFrame>) {
        current?.dispatchFrame(frame);
      },
      exit() {
        current?.onExit();
      },
      runs,
      cancel: vi.fn(),
    } as unknown as ReturnType<typeof makeStreamHarness>;
    const queryClient = makeQueryClient();
    let attempt = 0;
    const controller = createMobileRecoveryController({
      client: makeClient({
        readBaseline: async ({ recoveryAttemptId }) => makeBaseline(recoveryAttemptId, attempt),
        stream,
      }) as never,
      queryClient,
      sessionId,
      scheduler: makeScheduler(),
      makeAttemptId: () => `attempt-${++attempt}`,
    });

    controller.start();
    await settle();
    const refresh = controller.refresh(null);
    await settle();

    expect(runs).toHaveLength(2);
    expect(controller.getState().freshness).toBe("refreshing");
    stream.dispatch(makeFrame("attempt-2", { type: "caught-up", throughSequence: 2 }));
    await refresh;
    expect(controller.getState().freshness).toBe("current");
    controller.dispose();
  });

  it("discards queued events when a stream ends before its marker", async () => {
    const stream = makeStreamHarness();
    const queryClient = makeQueryClient();
    const scheduler = makeScheduler();
    const client = makeClient({
      readBaseline: async ({ recoveryAttemptId }) => makeBaseline(recoveryAttemptId, 0),
      stream,
    });
    const controller = createMobileRecoveryController({
      client: client as never,
      queryClient,
      sessionId,
      scheduler,
      makeAttemptId: () => "attempt-1",
    });

    controller.start();
    await settle();
    stream.dispatch(
      makeFrame("attempt-1", {
        type: "batch",
        batchId: "batch-1",
        events: [makeEvent(1)],
      }),
    );
    stream.exit();
    for (const callback of scheduler.microtaskCallbacks) callback();

    expect(controller.getState()).toMatchObject({
      freshness: "stale",
      reason: "recovery-stream-ended",
    });
    expect(queryClient.getQueryData(["mobile-snapshot", sessionId])).toBeDefined();
    controller.dispose();
  });

  it("does not mark current when queued event application is incomplete", async () => {
    const stream = makeStreamHarness();
    const queryClient = makeQueryClient();
    const controller = createMobileRecoveryController({
      client: makeClient({
        readBaseline: async ({ recoveryAttemptId }) => makeBaseline(recoveryAttemptId, 0),
        stream,
      }) as never,
      queryClient,
      sessionId,
      scheduler: makeScheduler(),
      makeAttemptId: () => "attempt-1",
    });

    controller.start();
    await settle();
    stream.dispatch(
      makeFrame("attempt-1", {
        type: "batch",
        batchId: "batch-1",
        events: [makeEvent(1)],
      }),
    );
    stream.dispatch(makeFrame("attempt-1", { type: "caught-up", throughSequence: 1 }));

    expect(controller.getState()).toMatchObject({
      freshness: "stale",
      reason: "unknown-event",
      actionsAvailable: false,
    });
    controller.dispose();
  });

  it("does not activate legacy fallback for a generic baseline failure", async () => {
    const stream = makeStreamHarness();
    const queryClient = makeQueryClient();
    const scheduler = makeScheduler();
    const client = makeClient({
      readBaseline: async () => {
        throw new Error("Timed out waiting for mobile recovery.");
      },
      stream,
      snapshot: makeSnapshot(4),
    });
    const controller = createMobileRecoveryController({
      client: client as never,
      queryClient,
      sessionId,
      scheduler,
      makeAttemptId: () => "attempt-1",
    });

    controller.start();
    await settle();

    expect(client.getSnapshot).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({
      freshness: "unavailable",
      actionsAvailable: false,
    });
    controller.dispose();
  });

  it("fails a recovery attempt when it reaches its client deadline", async () => {
    const stream = makeStreamHarness();
    const queryClient = makeQueryClient();
    const scheduler = makeScheduler();
    const client = makeClient({
      readBaseline: async ({ recoveryAttemptId }) => makeBaseline(recoveryAttemptId, 0),
      stream,
    });
    const controller = createMobileRecoveryController({
      client: client as never,
      queryClient,
      sessionId,
      scheduler,
      makeAttemptId: () => "attempt-1",
    });

    controller.start();
    await settle();
    scheduler.timeoutCallbacks[0]?.();

    expect(controller.getState()).toMatchObject({
      freshness: "stale",
      reason: "recovery-timeout",
    });
    expect(stream.cancel).toHaveBeenCalled();
    controller.dispose();
  });

  it("cancels a baseline request when the client deadline expires", async () => {
    const stream = makeStreamHarness();
    const queryClient = makeQueryClient();
    const scheduler = makeScheduler();
    let resolveBaseline: ((baseline: MobileRecoveryBaseline) => void) | undefined;
    let signal: AbortSignal | undefined;
    const client = makeClient({
      readBaseline: (_input, nextSignal) => {
        signal = nextSignal;
        return new Promise((resolve) => {
          resolveBaseline = resolve;
        });
      },
      stream,
    });
    const controller = createMobileRecoveryController({
      client: client as never,
      queryClient,
      sessionId,
      scheduler,
      makeAttemptId: () => "attempt-1",
    });

    controller.start();
    await settle();
    scheduler.timeoutCallbacks[0]?.();

    expect(signal?.aborted).toBe(true);
    expect(controller.getState()).toMatchObject({
      freshness: "unavailable",
      reason: "recovery-timeout",
    });
    resolveBaseline?.(makeBaseline("attempt-1", 0));
    controller.dispose();
  });

  it("uses legacy fallback only for an explicitly unsupported recovery method", async () => {
    const stream = makeStreamHarness();
    const queryClient = makeQueryClient();
    const client = makeClient({
      readBaseline: async () => {
        throw new MobileRecoveryUnsupportedError("mobile.recovery.getBaseline");
      },
      stream,
      snapshot: makeSnapshot(4),
    });
    const controller = createMobileRecoveryController({
      client: client as never,
      queryClient,
      sessionId,
      scheduler: makeScheduler(),
    });

    controller.start();
    await settle();

    expect(client.getSnapshot).toHaveBeenCalledOnce();
    expect(controller.getState()).toMatchObject({ freshness: "legacy", actionsAvailable: true });
    controller.dispose();
  });
});
