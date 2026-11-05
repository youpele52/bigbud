import { afterEach, expect, it, vi } from "vitest";
import { makeTerminalStartupRecovery } from "./TerminalViewport.startup";

afterEach(() => vi.useRealTimers());

it.each(["resolve", "reject"] as const)(
  "fences a late startup %s after recovery",
  async (settlement) => {
    let resolve!: (value: boolean) => void;
    let reject!: (error: Error) => void;
    let isSuperseded!: () => boolean;
    const open = vi.fn((superseded: () => boolean) => {
      isSuperseded = superseded;
      return new Promise<boolean>((done, fail) => {
        resolve = done;
        reject = fail;
      });
    });
    const onFailure = vi.fn();
    const startup = makeTerminalStartupRecovery({ open, onFailure });
    const pending = startup.run(true);
    expect(isSuperseded()).toBe(false);
    startup.invalidate();
    expect(isSuperseded()).toBe(true);
    if (settlement === "resolve") resolve(false);
    else reject(new Error("Old snapshot failed"));
    await pending;
    expect(onFailure).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledOnce();
  },
);

it("cancels a deferred size retry when lifecycle recovery supersedes it", async () => {
  vi.useFakeTimers();
  const open = vi.fn(async () => false);
  const startup = makeTerminalStartupRecovery({ open, onFailure: vi.fn() });
  await startup.run();
  startup.invalidate();
  await vi.advanceTimersByTimeAsync(100);
  expect(open).toHaveBeenCalledOnce();
});

it("reports current failures and retries with the same attach-only policy", async () => {
  vi.useFakeTimers();
  const onFailure = vi.fn();
  const failure = new Error("Current startup failed");
  const open = vi.fn(async (_superseded: () => boolean, _attachOnly: boolean) => false);
  open.mockRejectedValueOnce(failure).mockResolvedValueOnce(false).mockResolvedValue(true);
  const startup = makeTerminalStartupRecovery({ open, onFailure });
  await startup.run(true);
  expect(onFailure).toHaveBeenCalledExactlyOnceWith(failure);
  await startup.run(true);
  await vi.advanceTimersByTimeAsync(50);
  expect(open).toHaveBeenCalledTimes(3);
  expect(open.mock.calls.map(([, attachOnly]) => attachOnly)).toEqual([true, true, true]);
  startup.invalidate();
});
