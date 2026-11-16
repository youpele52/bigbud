import { CommandId, ThreadId } from "@bigbud/contracts";
import { OrchestrationDispatchCommandError } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vitest";
import { createMobileCommandDeliveryController } from "./mobileCommandDelivery";

const command = {
  type: "thread.turn.interrupt" as const,
  commandId: CommandId.makeUnsafe("permission-command"),
  threadId: ThreadId.makeUnsafe("thread"),
  createdAt: "2026-11-14T00:00:00Z",
};
const denied = new OrchestrationDispatchCommandError({
  message: "Scope denied",
  code: "unauthorized",
});
it.each([denied, Cause.fail(denied), new Error("RPC failed", { cause: Cause.fail(denied) })])(
  "settles typed permission failure without outcome lookup or resend",
  async (error) => {
    const controller = createMobileCommandDeliveryController();
    const state = await controller.submit({
      command,
      submittedRevision: 1,
      dispatch: () => Promise.reject(error),
    });
    expect(state.status).toBe("rejected");
    const read = vi.fn();
    const send = vi.fn();
    await controller.reconcile(read);
    await controller.retrySameOperation(send);
    expect(read).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  },
);
it.each([
  new Error("unauthorized"),
  Cause.die(denied),
  new Error("socket closed"),
  new OrchestrationDispatchCommandError({ message: "overloaded", code: "overloaded" }),
])("keeps unproven acceptance uncertain", async (error) => {
  const controller = createMobileCommandDeliveryController();
  expect(
    (
      await controller.submit({
        command,
        submittedRevision: 1,
        dispatch: () => Promise.reject(error),
      })
    ).status,
  ).toBe("uncertain");
});
it("handles synchronous denial and denial of same-ID retry", async () => {
  const controller = createMobileCommandDeliveryController();
  await controller.submit({
    command,
    submittedRevision: 1,
    dispatch: () => Promise.reject(new Error("lost")),
  });
  const retry = vi.fn(() => {
    throw denied;
  });
  expect((await controller.retrySameOperation(retry)).status).toBe("rejected");
  expect(retry).toHaveBeenCalledWith(command);
  const fresh = createMobileCommandDeliveryController();
  expect((await fresh.submit({ command, submittedRevision: 1, dispatch: retry })).status).toBe(
    "rejected",
  );
});
