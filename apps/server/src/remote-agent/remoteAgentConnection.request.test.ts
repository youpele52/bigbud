import { expect, it, vi } from "vitest";
import { requestRemoteFrame, type FrameWaiter } from "./remoteAgentConnection.request";

it("retires cancelled observation without touching sibling requests or re-sending", async () => {
  const waiters: FrameWaiter[] = [];
  const send = vi.fn(async () => {});
  const controller = new AbortController();
  const first = requestRemoteFrame(waiters, send, () => true, controller.signal);
  const second = requestRemoteFrame(waiters, send, () => true);
  const rejected = expect(first).rejects.toThrow("cancelled");
  expect(waiters).toHaveLength(2);
  controller.abort();
  await rejected;
  expect(waiters).toHaveLength(1);
  waiters[0]!.resolve({
    type: "ptySignalResponse",
    value: { ptyId: "p", requestId: "r", accepted: true, errorCode: "", errorMessage: "" },
  });
  await second;
  expect(waiters).toHaveLength(0);
  expect(send).toHaveBeenCalledTimes(2);
});

it("pre-cancelled observation never dispatches and late send failures remain handled", async () => {
  const waiters: FrameWaiter[] = [];
  const controller = new AbortController();
  controller.abort();
  const send = vi.fn(async () => {});
  await expect(requestRemoteFrame(waiters, send, () => true, controller.signal)).rejects.toThrow(
    "cancelled",
  );
  expect(send).not.toHaveBeenCalled();
  const next = new AbortController();
  let fail!: (error: Error) => void;
  const pending = requestRemoteFrame(
    waiters,
    () =>
      new Promise<void>((_, reject) => {
        fail = reject;
      }),
    () => true,
    next.signal,
  );
  const rejected = expect(pending).rejects.toThrow("cancelled");
  next.abort();
  await rejected;
  fail(new Error("late pipe failure"));
  await Promise.resolve();
  expect(waiters).toHaveLength(0);
});
