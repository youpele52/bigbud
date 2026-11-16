import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./remoteAgentLocalControl.windows.ts", () => ({
  sendWindowsControlRequest: mocks.request,
  WindowsControlUnavailableError: class extends Error {},
}));
import { waitForRemoteAgentOperation } from "./remoteAgentLocalControl.client.ts";
const original = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", original);
  vi.useRealTimers();
  vi.clearAllMocks();
});
it("retries a Windows lost reply with the same operation ID and never reissues install", async () => {
  Object.defineProperty(process, "platform", { ...original, value: "win32" });
  vi.useFakeTimers();
  mocks.request
    .mockRejectedValueOnce(new Error("lost response"))
    .mockResolvedValueOnce({ v: 1, ok: true, result: { state: "completed" } });
  const result = waitForRemoteAgentOperation("socket", "operation-id");
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toMatchObject({ ok: true });
  expect(mocks.request).toHaveBeenCalledTimes(2);
  for (const [, request] of mocks.request.mock.calls)
    expect(request).toEqual({ method: "operation", operationId: "operation-id", waitMs: 25_000 });
});
