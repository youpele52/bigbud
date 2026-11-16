import { CommandId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { describe, expect, it, vi } from "vitest";

import { createMobileDeliveryOwner } from "./MobileThread.delivery.owner";

const command = {
  type: "thread.turn.interrupt" as const,
  commandId: CommandId.makeUnsafe("owner-command"),
  threadId: ThreadId.makeUnsafe("owner-thread"),
  createdAt: "2026-11-16T00:00:00.000Z",
};
const input = {
  identity: "fixture-owner",
  submitted: null,
  decisionSubmitted: null,
  onStateChange: vi.fn(),
  onDecisionStateChange: vi.fn(),
};

describe("mobile delivery owner effect replay", () => {
  it("creates an active owner after terminal cleanup so a user action can dispatch", async () => {
    const initial = createMobileDeliveryOwner(input);
    initial.dispose();
    const replay = initial.recreate();
    const dispatch = vi.fn(async () => undefined);
    const result = await replay.delivery.submit({ command, submittedRevision: 1, dispatch });
    expect(result.admitted).toBe(true);
    expect(result.status).toBe("accepted");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(command);
    replay.dispose();
  });

  it("preserves an uncertain command ID without replaying it or accepting a late old result", async () => {
    const owner = createMobileDeliveryOwner(input);
    let accept: () => void = vi.fn();
    const held = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const dispatch = vi.fn(() => held);
    const pending = owner.delivery.submit({ command, submittedRevision: 3, dispatch });
    expect(owner.delivery.getState().status).toBe("pending");
    owner.dispose();
    const replay = owner.recreate();
    expect(replay.delivery.getState().status).toBe("uncertain");
    expect(replay.delivery.getState().operation?.command.commandId).toBe(command.commandId);
    const retry = await replay.delivery.submit({ command, submittedRevision: 4, dispatch });
    expect(retry.admitted).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
    accept();
    await pending;
    expect(replay.delivery.getState().status).toBe("uncertain");
    expect(replay.delivery.getState().operation?.submittedRevision).toBe(3);
    replay.dispose();
  });
});
