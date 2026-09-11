import { CommandId, ThreadId, type ClientOrchestrationCommand } from "@bigbud/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMobileCommandDeliveryController } from "./mobileCommandDelivery";

function makeCommand(id: string): ClientOrchestrationCommand {
  return {
    type: "thread.turn.interrupt",
    commandId: CommandId.makeUnsafe(id),
    threadId: ThreadId.makeUnsafe("thread-1"),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("mobile command delivery", () => {
  beforeEach(() => vi.useRealTimers());

  it("locks duplicate activation before dispatch crosses an async boundary", async () => {
    let resolveDispatch: (() => void) | undefined;
    const dispatch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDispatch = resolve;
        }),
    );
    const controller = createMobileCommandDeliveryController({ deadlineMs: 1_000 });
    const first = controller.submit({
      command: makeCommand("command-1"),
      dispatch,
      submittedRevision: 1,
    });
    const second = controller.submit({
      command: makeCommand("command-2"),
      dispatch,
      submittedRevision: 2,
    });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(controller.getState().status).toBe("pending");
    expect(await second).toBe(controller.getState());
    resolveDispatch?.();
    await expect(first).resolves.toMatchObject({ status: "accepted" });
  });

  it("turns a deadline into uncertainty and reconciles without resending", async () => {
    vi.useFakeTimers();
    let resolveDispatch: (() => void) | undefined;
    const dispatch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDispatch = resolve;
        }),
    );
    const controller = createMobileCommandDeliveryController({ deadlineMs: 100 });
    const submitted = controller.submit({
      command: makeCommand("command-uncertain"),
      dispatch,
      submittedRevision: 5,
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(submitted).resolves.toMatchObject({ status: "uncertain" });
    expect(dispatch).toHaveBeenCalledOnce();

    const reconciled = await controller.reconcile(async () => ({ status: "accepted" }));
    expect(reconciled.status).toBe("accepted");
    expect(dispatch).toHaveBeenCalledOnce();
    resolveDispatch?.();
  });

  it("keeps rejection distinct from transport uncertainty", async () => {
    const controller = createMobileCommandDeliveryController();
    await expect(
      controller.submit({
        command: makeCommand("command-rejected"),
        dispatch: async () => {
          throw new Error("transport failed");
        },
        submittedRevision: 2,
      }),
    ).resolves.toMatchObject({ status: "uncertain" });
    await expect(
      controller.reconcile(async () => ({ status: "rejected", reason: "other" })),
    ).resolves.toMatchObject({ status: "rejected", rejectionReason: "other" });
  });

  it("retries only the original immutable operation when explicitly requested", async () => {
    vi.useFakeTimers();
    const dispatch = vi.fn(() => Promise.reject(new Error("connection lost")));
    const controller = createMobileCommandDeliveryController({ deadlineMs: 100 });
    await expect(
      controller.submit({
        command: makeCommand("command-same-id"),
        dispatch,
        submittedRevision: 1,
      }),
    ).resolves.toMatchObject({ status: "uncertain" });
    const retriedCommands: ClientOrchestrationCommand[] = [];
    const retried = await controller.retrySameOperation(async (command) => {
      retriedCommands.push(command);
    });
    expect(retried.operation?.command.commandId).toBe("command-same-id");
    expect(retried.operation?.submittedRevision).toBe(1);
    expect(retriedCommands[0]).toEqual(makeCommand("command-same-id"));
  });

  it("turns a synchronous dispatch throw into uncertainty and releases the lock", async () => {
    const controller = createMobileCommandDeliveryController();
    await expect(
      controller.submit({
        command: makeCommand("command-sync-throw"),
        dispatch: () => {
          throw new Error("socket is closed");
        },
        submittedRevision: 1,
      }),
    ).resolves.toMatchObject({ status: "uncertain" });
    expect(controller.getState().status).toBe("uncertain");
  });

  it("gives an explicit same-id retry a fresh bounded deadline", async () => {
    vi.useFakeTimers();
    const controller = createMobileCommandDeliveryController({ deadlineMs: 100 });
    await expect(
      controller.submit({
        command: makeCommand("command-fresh-deadline"),
        dispatch: () => Promise.reject(new Error("lost")),
        submittedRevision: 1,
      }),
    ).resolves.toMatchObject({ status: "uncertain" });
    await vi.advanceTimersByTimeAsync(50);
    const retry = controller.retrySameOperation(() => new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(99);
    expect(controller.getState().status).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await expect(retry).resolves.toMatchObject({ status: "uncertain" });
  });

  it("settles a pending operation when its owner is disposed", async () => {
    let resolveDispatch: (() => void) | undefined;
    const controller = createMobileCommandDeliveryController();
    const pending = controller.submit({
      command: makeCommand("command-dispose"),
      dispatch: () =>
        new Promise<void>((resolve) => {
          resolveDispatch = resolve;
        }),
      submittedRevision: 1,
    });
    controller.dispose();
    await expect(pending).resolves.toMatchObject({ status: "uncertain" });
    expect(controller.getState().status).toBe("uncertain");
    resolveDispatch?.();
  });
});
