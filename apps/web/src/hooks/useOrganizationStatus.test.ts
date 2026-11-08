import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../rpc/wsRpcClient", () => ({ getWsRpcClient: () => ({}) }));
vi.mock("../rpc/wsConnectionState", () => ({ useWsConnectionStatus: () => ({}) }));
import { createOrganizationStatusStore } from "./useOrganizationStatus";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("shares one poll across subscribers and stops when the last one leaves", async () => {
  const read = vi.fn().mockResolvedValue({ state: "healthy", changedAtMs: 1, installation: "new" });
  const store = createOrganizationStatusStore(read);
  store.connect("socket|a");
  const first = store.subscribe(() => {});
  const second = store.subscribe(() => {});
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  expect(store.snapshot()).toMatchObject({ state: "healthy" });
  await vi.advanceTimersByTimeAsync(5000);
  expect(read).toHaveBeenCalledTimes(2);
  first();
  second();
  await vi.advanceTimersByTimeAsync(20000);
  expect(read).toHaveBeenCalledTimes(2);
});

it("a reconnect discards the previous status and ignores late replies from it", async () => {
  let resolve: ((value: unknown) => void) | undefined;
  const read = vi.fn(() => new Promise((done) => (resolve = done)));
  const store = createOrganizationStatusStore(read as never);
  store.connect("socket|a");
  const stop = store.subscribe(() => {});
  store.connect("socket|b");
  resolve?.({ state: "paused", changedAtMs: 1, installation: "existing" });
  await vi.advanceTimersByTimeAsync(0);
  expect(store.snapshot()).toBeUndefined();
  stop();
});
