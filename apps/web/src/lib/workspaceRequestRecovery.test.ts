import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceRequestRecovery } from "./workspaceRequestRecovery";

const transient = new Error(
  "mux_client_request_session: session request failed: Session open refused by peer",
);
const controllers: WorkspaceRequestRecovery[] = [];
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
function controller(remote = true) {
  const value = new WorkspaceRequestRecovery(remote);
  controllers.push(value);
  return value;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const value of controllers.splice(0)) value.dispose();
  vi.useRealTimers();
});

describe("WorkspaceRequestRecovery", () => {
  it("retries a transient failure and returns immediately after success", async () => {
    const request = vi.fn().mockRejectedValueOnce(transient).mockResolvedValue("files");
    const onRecovering = vi.fn();
    const onError = vi.fn();
    const result = controller().execute("docs", request, { onRecovering, onError });
    await vi.advanceTimersByTimeAsync(999);
    expect(request).toHaveBeenCalledTimes(1);
    expect(onRecovering).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("files");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reset the first-failure deadline on subsequent failures", async () => {
    const request = vi.fn().mockRejectedValue(transient);
    const onError = vi.fn();
    const value = controller();
    const result = value.execute("docs", request, { onError }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(transient);
    expect(onError).toHaveBeenCalledWith(transient, false);
    const attempts = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(attempts);
    expect(value.isActive("docs")).toBe(false);
  });

  it("gives a full recovery window after a slow first attempt fails", async () => {
    const first = createDeferred<string>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockRejectedValue(transient);
    const onError = vi.fn();
    const result = controller()
      .execute("docs", request, { onError })
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    first.reject(transient);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(transient);
  });

  it("times out hung reads without allowing overlapping retries and accepts a late success", async () => {
    const deferred = createDeferred<string>();
    const request = vi.fn(() => deferred.promise);
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const value = controller();
    const result = value.execute("docs", request, { onSuccess, onError }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toBeInstanceOf(Error);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), true);
    expect(value.isActive("docs")).toBe(true);
    await value.execute("docs", request).catch(() => undefined);
    expect(request).toHaveBeenCalledOnce();
    deferred.resolve("late files");
    await vi.advanceTimersByTimeAsync(0);
    expect(onSuccess).toHaveBeenCalledWith("late files");
    expect(value.isActive("docs")).toBe(false);
  });

  it("unlocks Retry after a timed-out request eventually rejects", async () => {
    const deferred = createDeferred<string>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => deferred.promise)
      .mockResolvedValue("new files");
    const onError = vi.fn();
    const value = controller();
    const result = value.execute("docs", request, { onError }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    deferred.reject(transient);
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenLastCalledWith(transient, false);
    await expect(value.execute("docs", request)).resolves.toBe("new files");
  });

  it("does not delay or retry permanent errors", async () => {
    const error = new Error("Permission denied (publickey).");
    const request = vi.fn().mockRejectedValue(error);
    const onError = vi.fn();
    await expect(controller().execute("docs", request, { onError })).rejects.toBe(error);
    expect(onError).toHaveBeenCalledWith(error, false);
    expect(vi.getTimerCount()).toBe(0);
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps local reads immediate without remote retry policy", async () => {
    const request = vi.fn().mockRejectedValue(transient);
    await expect(controller(false).execute("docs", request)).rejects.toBe(transient);
    expect(vi.getTimerCount()).toBe(0);
    expect(request).toHaveBeenCalledOnce();
  });

  it("deduplicates reads and serializes different remote folders", async () => {
    const first = createDeferred<string>();
    const request = vi.fn(() => first.promise);
    const second = vi.fn().mockResolvedValue("second");
    const value = controller();
    const result = value.execute("docs", request);
    expect(value.execute("docs", request)).toBe(result);
    const other = value.execute("src", second);
    expect(second).not.toHaveBeenCalled();
    first.resolve("first");
    await expect(result).resolves.toBe("first");
    await expect(other).resolves.toBe("second");
    expect(request).toHaveBeenCalledOnce();
  });

  it("spaces retries across expanded folders instead of retrying them all at once", async () => {
    const value = controller();
    const request = vi.fn().mockRejectedValue(transient);
    const results = ["docs", "src", "tests"].map((key) =>
      value.execute(key, request).catch(() => undefined),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(999);
    expect(request).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(28_000);
    await Promise.all(results);
    expect(value.isActive("docs")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("notifies settlement only after a timed-out RPC actually finishes", async () => {
    const deferred = createDeferred<string>();
    const onSettled = vi.fn();
    const value = controller();
    const result = value
      .execute("docs", () => deferred.promise, { onSettled })
      .catch(() => undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect(onSettled).not.toHaveBeenCalled();
    deferred.resolve("late");
    await vi.advanceTimersByTimeAsync(0);
    expect(onSettled).toHaveBeenCalledOnce();
    expect(value.isActive("docs")).toBe(false);
  });

  it("bounds queued reads behind a hung operation", async () => {
    const deferred = createDeferred<string>();
    const value = controller();
    const result = value.execute("docs", () => deferred.promise).catch((error) => error);
    const second = vi.fn().mockResolvedValue("files");
    const queued = value.execute("src", second).catch((error) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toBeInstanceOf(Error);
    expect(await queued).toBeInstanceOf(Error);
    deferred.resolve("late");
    await vi.advanceTimersByTimeAsync(0);
    expect(second).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels retries and ignores completions after workspace disposal", async () => {
    const deferred = createDeferred<string>();
    const onSuccess = vi.fn();
    const value = controller();
    const result = value
      .execute("docs", () => deferred.promise, { onSuccess })
      .catch((error) => error);
    value.dispose();
    expect(await result).toMatchObject({ name: "AbortError" });
    value.resume();
    await expect(value.execute("docs", async () => "new workspace")).resolves.toBe("new workspace");
    deferred.resolve("old workspace");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a scheduled retry on disposal", async () => {
    const request = vi.fn().mockRejectedValue(transient);
    const value = controller();
    const result = value.execute("docs", request).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    value.dispose();
    expect(await result).toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
