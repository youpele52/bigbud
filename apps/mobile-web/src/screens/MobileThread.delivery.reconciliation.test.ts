import { CommandId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { describe, expect, it, vi } from "vitest";

import { createMobileDeliveryOwner } from "./MobileThread.delivery.owner";
import { createMobileDeliveryReconciliationTracker } from "./MobileThread.delivery.reconciliation";
import type { MobileCommandOutcome } from "../lib/mobileCommandDelivery.logic";

describe("receipt reconciliation ownership during effect replay", () => {
  it("rechecks an interrupted read on the recreated owner and ignores its late old outcome", async () => {
    const command = {
      type: "thread.turn.interrupt" as const,
      commandId: CommandId.makeUnsafe("original-receipt-command"),
      threadId: ThreadId.makeUnsafe("receipt-thread"),
      createdAt: "2026-11-16T00:00:00.000Z",
    };
    const original = createMobileDeliveryOwner({
      identity: "receipt-owner",
      submitted: {
        command,
        status: "uncertain",
        submittedRevision: 7,
        submittedAt: command.createdAt,
        deadlineAt: 0,
      },
      decisionSubmitted: null,
      onStateChange: vi.fn(),
      onDecisionStateChange: vi.fn(),
    });
    const tracker = createMobileDeliveryReconciliationTracker();
    expect(tracker.select(original.delivery)).toBe(command.commandId);
    let accept: (outcome: MobileCommandOutcome) => void = vi.fn();
    const held = new Promise<MobileCommandOutcome>((resolve) => {
      accept = resolve;
    });
    const readOld = vi.fn(() => held);
    const pending = original.delivery.reconcile(readOld);
    original.dispose();
    const replacement = original.recreate();
    expect(tracker.select(replacement.delivery)).toBe(command.commandId);
    expect(tracker.select(replacement.delivery)).toBeNull();
    accept({ status: "accepted" });
    await pending;
    expect(replacement.delivery.getState().status).toBe("uncertain");
    const readCurrent = vi.fn(async (): Promise<MobileCommandOutcome> => ({ status: "unknown" }));
    await replacement.delivery.reconcile(readCurrent);
    expect(readOld).toHaveBeenCalledOnce();
    expect(readCurrent).toHaveBeenCalledOnce();
    expect(replacement.delivery.getState().operation?.command.commandId).toBe(command.commandId);
    expect(replacement.delivery.getState().outcomeUnknown).toBe(true);
    tracker.reset();
    expect(tracker.select(replacement.delivery)).toBeNull();
    replacement.dispose();
  });
});
