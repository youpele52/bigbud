import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThreadId } from "@bigbud/contracts";
import type { ThreadOrganizationState } from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import { makeEvent } from "../stores/main/main.store.test.helpers";

const mocks = vi.hoisted(() => ({ toast: vi.fn(), dispatch: vi.fn() }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("../rpc/nativeApi", () => ({ readNativeApi: () => ({ orchestration: {} }) }));
vi.mock("./orchestrationCommandRecovery", () => ({
  dispatchCommandWithOutcomeRecovery: mocks.dispatch,
}));
import { createOrganizationNotifications } from "./organizationNotifications.delivery";

const event = (
  sequence: number,
  threadId = "thread",
  state: ThreadOrganizationState = "later",
  from: ThreadOrganizationState = "present",
) => ({
  ...makeEvent("thread.organization-updated", {
    threadId: ThreadId.makeUnsafe(threadId),
    reason: "idle",
    source: "automatic",
    organization: { state, revision: 2, changedAt: null, snooze: null },
    automaticMove: {
      operationId: `operation-${sequence}`,
      from,
      reason: state === "present" && from === "needs-you" ? "resolved" : "target",
    },
  }),
  sequence,
  occurredAt: "2026-11-05T12:00:01.000Z",
});
beforeEach(() => {
  vi.useFakeTimers();
  mocks.toast.mockReset();
  mocks.dispatch.mockReset().mockResolvedValue({ sequence: 3 });
});
afterEach(() => vi.useRealTimers());

it("coalesces proposals and sends each immutable identity on Undo without claiming success", async () => {
  const notifications = createOrganizationNotifications();
  notifications.arm(1);
  notifications.add([event(2)]);
  notifications.add([event(3, "other")]);
  await vi.advanceTimersByTimeAsync(500);
  expect(mocks.toast).toHaveBeenCalledOnce();
  const toast = mocks.toast.mock.calls[0]![0];
  expect(toast.title).toBe("Moved 2 threads to Later");
  toast.actionProps.onClick();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.dispatch).toHaveBeenCalledTimes(2);
  expect(mocks.dispatch.mock.calls[1]![1]).toMatchObject({
    undoAutomaticMoveId: "operation-2",
    expectedRevision: 2,
    state: "present",
  });
  expect(mocks.toast).toHaveBeenCalledOnce();
  notifications.dispose();
});
it("ignores client clock skew of a minute either way", async () => {
  for (const skew of [-60_000, 60_000]) {
    vi.setSystemTime(Date.parse("2026-11-05T12:00:02.000Z") + skew);
    mocks.toast.mockReset();
    const notifications = createOrganizationNotifications();
    notifications.arm(1);
    notifications.add([event(2)]);
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.toast).toHaveBeenCalledOnce();
    notifications.dispose();
  }
});
it("never toasts before live, replays below the frontier, duplicates or after disarm", async () => {
  const notifications = createOrganizationNotifications();
  notifications.add([event(2)]);
  notifications.arm(5);
  notifications.add([event(4), event(5)]);
  await vi.advanceTimersByTimeAsync(500);
  expect(mocks.toast).not.toHaveBeenCalled();
  notifications.add([event(6)]);
  notifications.add([event(6)]);
  await vi.advanceTimersByTimeAsync(500);
  expect(mocks.toast).toHaveBeenCalledOnce();
  notifications.add([event(7)]);
  notifications.disarm();
  notifications.add([event(8)]);
  await vi.advanceTimersByTimeAsync(500);
  expect(mocks.toast).toHaveBeenCalledOnce();
  notifications.dispose();
});
it("reports partial dispatch failure without claiming restoration", async () => {
  mocks.dispatch.mockRejectedValueOnce(new Error("offline"));
  const notifications = createOrganizationNotifications();
  notifications.arm(0);
  notifications.add([event(1)]);
  await vi.advanceTimersByTimeAsync(500);
  mocks.toast.mock.calls[0]![0].actionProps.onClick();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.toast.mock.calls[1]![0]).toMatchObject({ type: "error" });
  notifications.dispose();
});
it.each(["done", "later", "needs-you"] as const)(
  "does not toast or offer Undo for an automatic %s return to Present",
  async (from) => {
    const notifications = createOrganizationNotifications();
    notifications.arm(0);
    notifications.add([event(1, "thread", "present", from)]);
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    notifications.dispose();
  },
);
it.each([
  ["later", "Later"],
  ["done", "Done"],
  ["needs-you", "Needs you"],
] as const)("preserves a Present move to %s and its Undo", async (state, label) => {
  const notifications = createOrganizationNotifications();
  notifications.arm(0);
  notifications.add([event(1, "thread", state)]);
  await vi.advanceTimersByTimeAsync(500);
  expect(mocks.toast).toHaveBeenCalledOnce();
  const toast = mocks.toast.mock.calls[0]![0];
  expect(toast).toMatchObject({
    type: "success",
    title: `Moved to ${label}`,
    actionProps: { children: "Undo" },
  });
  toast.actionProps.onClick();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    expect.objectContaining({
      type: "thread.organization.move",
      threadId: "thread",
      state: "present",
      expectedRevision: 2,
      undoAutomaticMoveId: "operation-1",
    }),
  );
  expect(mocks.toast).toHaveBeenCalledOnce();
  notifications.dispose();
});
it("preserves non-Present destinations in a mixed batch and excludes returns from Undo", async () => {
  const notifications = createOrganizationNotifications();
  notifications.arm(0);
  notifications.add([
    event(1, "returning", "present", "later"),
    event(2, "outgoing", "done"),
    event(3, "between", "done", "later"),
  ]);
  await vi.advanceTimersByTimeAsync(500);
  expect(mocks.toast).toHaveBeenCalledOnce();
  const toast = mocks.toast.mock.calls[0]![0];
  expect(toast.title).toBe("Moved 2 threads to Done");
  toast.actionProps.onClick();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.dispatch.mock.calls.map((call) => call[1])).toEqual([
    expect.objectContaining({
      threadId: "between",
      state: "later",
      undoAutomaticMoveId: "operation-3",
    }),
    expect.objectContaining({
      threadId: "outgoing",
      state: "present",
      undoAutomaticMoveId: "operation-2",
    }),
  ]);
  notifications.dispose();
});
it("advances the frontier past suppressed Present returns", async () => {
  const notifications = createOrganizationNotifications();
  notifications.arm(0);
  notifications.add([event(5, "returning", "present", "done")]);
  notifications.add([event(4)]);
  await vi.advanceTimersByTimeAsync(500);
  expect(mocks.toast).not.toHaveBeenCalled();
  notifications.add([event(6)]);
  await vi.advanceTimersByTimeAsync(500);
  expect(mocks.toast).toHaveBeenCalledOnce();
  notifications.dispose();
});
