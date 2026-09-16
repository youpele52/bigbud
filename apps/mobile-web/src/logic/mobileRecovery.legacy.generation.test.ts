import { MobileRecoveryUnsupportedError } from "../lib/mobileRpc.errors";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { describe, expect, it, vi } from "vitest";

import { createMobileRecoveryController } from "./mobileRecovery.controller";
import {
  makeClient,
  makeEvent,
  makeQueryClient,
  makeScheduler,
  makeSnapshot,
  makeStreamHarness,
  settle,
  sessionId,
} from "./mobileRecovery.test.utils";

describe("legacy recovery generation fencing", () => {
  it("does not let a delayed selected-thread read overwrite a newer summary", async () => {
    const stream = makeStreamHarness();
    const queryClient = makeQueryClient();
    let resolveSelected: (() => void) | undefined;
    const client = {
      ...makeClient({
        readBaseline: async () => {
          throw new MobileRecoveryUnsupportedError("mobile.recovery.getBaseline");
        },
        snapshot: makeSnapshot(4),
        stream,
      }),
      getMobileThread: vi.fn(
        () =>
          new Promise<never>((resolve) => {
            resolveSelected = () => resolve(undefined as never);
          }),
      ),
    };
    const controller = createMobileRecoveryController({
      client: client as never,
      queryClient,
      sessionId,
      scheduler: makeScheduler(),
    });

    controller.start();
    await settle();
    const selected = controller.selectThread(ThreadId.makeUnsafe("thread-1"));
    await settle();
    const summary = controller.refresh(null);
    await summary;

    resolveSelected?.();
    await expect(selected).rejects.toThrow("superseded");
    expect(controller.getState()).toMatchObject({
      freshness: "legacy",
      selectedThreadId: null,
      reason: "recovery-unsupported",
    });
    expect(queryClient.getQueryData(["mobile-snapshot", sessionId])).toEqual(makeSnapshot(4));
    controller.dispose();
  });

  it("marks legacy freshness incomplete when an event requires a refetch", async () => {
    const stream = makeStreamHarness();
    const queryClient = makeQueryClient();
    const scheduler = makeScheduler();
    let dispatchEvent: ((event: unknown) => void) | undefined;
    const client = {
      ...makeClient({
        readBaseline: async () => {
          throw new MobileRecoveryUnsupportedError("mobile.recovery.getBaseline");
        },
        snapshot: makeSnapshot(4),
        stream,
      }),
      onDomainEvent: vi.fn((listener: (event: unknown) => void) => {
        dispatchEvent = listener;
        return () => undefined;
      }),
    };
    const controller = createMobileRecoveryController({
      client: client as never,
      queryClient,
      sessionId,
      scheduler,
    });

    controller.start();
    await settle();
    dispatchEvent?.(makeEvent(1));
    scheduler.microtaskCallbacks[0]?.();

    expect(controller.getState()).toMatchObject({
      freshness: "stale",
      reason: "unknown-event",
      actionsAvailable: false,
    });
    controller.dispose();
  });
});
