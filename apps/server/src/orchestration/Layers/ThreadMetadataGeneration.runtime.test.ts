import { afterEach, describe, expect, it, vi } from "vitest";
import { closeMetadataRuntime, metadataAbortable } from "./ThreadMetadataGeneration.runtime.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const messages = { aborted: "fixture aborted" };

describe("shared native provider lifecycle", () => {
  it("preserves returned values and removes the abort listener", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await expect(
      metadataAbortable(Promise.resolve("result"), controller.signal, messages),
    ).resolves.toBe("result");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("preserves original errors unless the provider requests sanitized failures", async () => {
    const error = new Error("fixture-secret");
    const signal = new AbortController().signal;
    await expect(metadataAbortable(Promise.reject(error), signal, messages)).rejects.toBe(error);
    await expect(
      metadataAbortable(Promise.reject(error), signal, {
        ...messages,
        failed: "sanitized failure",
      }),
    ).rejects.toThrow(/^sanitized failure$/);
  });

  it("bounds an underlying operation that ignores cancellation and observes late rejection", async () => {
    const pending = Promise.withResolvers<void>();
    const controller = new AbortController();
    const bounded = metadataAbortable(pending.promise, controller.signal, messages);
    const rejected = expect(bounded).rejects.toThrow(/^fixture aborted$/);
    controller.abort();
    await rejected;
    pending.reject(new Error("fixture late rejection"));
    await Promise.resolve();
  });

  it("honors an already-aborted signal even when the operation already resolved", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      metadataAbortable(Promise.resolve("late"), controller.signal, messages),
    ).rejects.toThrow(/^fixture aborted$/);
  });

  it("does not warn or leave timers after successful cleanup", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await closeMetadataRuntime(async () => {}, "Codex");
    expect(warning).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds cleanup independently and observes a late failure", async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<void>();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cleanup = closeMetadataRuntime(() => pending.promise, "Codex");
    await vi.advanceTimersByTimeAsync(1_001);
    await cleanup;
    expect(warning).toHaveBeenCalledExactlyOnceWith("Codex metadata cleanup failed.");
    pending.reject(new Error("fixture late rejection"));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cannot replace an outcome through synchronous cleanup or diagnostic failures", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("diagnostic failure");
    });
    await expect(
      closeMetadataRuntime(() => {
        throw new Error("fixture-secret");
      }, "Codex"),
    ).resolves.toBeUndefined();
  });
});
