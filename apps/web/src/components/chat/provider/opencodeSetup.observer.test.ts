import { afterEach, expect, it, vi } from "vitest";
import type { ServerOpencodeV2ThreadToolsSetupResult } from "@bigbud/contracts/server/server.opencodeV2ThreadToolsSetup";
import { observeOpenCodeSetup } from "./opencodeSetup.observer";
import { deferredSetupReply } from "./opencodeSetup.test.fixture";

const ready: ServerOpencodeV2ThreadToolsSetupResult = {
  status: "ready",
  activationState: "ready",
  directory: "/workspace",
  artifactDirectoryUri: "",
  artifactDigest: "a".repeat(64),
  issuerKeyId: "",
  configAddition: { plugins: [] },
  message: "Verified",
  qualificationState: "unqualified",
  nativeVersion: "2.0.28",
};
const waiting: ServerOpencodeV2ThreadToolsSetupResult = {
  ...ready,
  status: "required",
  activationState: "waiting-for-idle",
  jobId: "b".repeat(32),
};
const input = { refresh: true, directory: "/workspace" } as const;
afterEach(() => vi.useRealTimers());

it("retains the authorized cancel interest while polling status-only replies", async () => {
  vi.useFakeTimers();
  const interestId = "c".repeat(32);
  const request = vi
    .fn()
    .mockResolvedValueOnce({ ...waiting, interestId })
    .mockResolvedValue(waiting);
  const result = vi.fn();
  const stop = observeOpenCodeSetup(request, input, result, vi.fn());
  await vi.advanceTimersByTimeAsync(4000);
  expect(result).toHaveBeenLastCalledWith({ ...waiting, interestId });
  expect(request).toHaveBeenLastCalledWith({ operation: "status", jobId: waiting.jobId });
  stop();
});

it("polls the same job and re-verifies the chat Location before reporting ready", async () => {
  vi.useFakeTimers();
  const request = vi
    .fn()
    .mockResolvedValueOnce(waiting)
    .mockResolvedValueOnce({ ...ready, directory: "/another-location" })
    .mockResolvedValueOnce(ready);
  const result = vi.fn();
  const error = vi.fn();
  const stop = observeOpenCodeSetup(request, input, result, error);
  await vi.advanceTimersByTimeAsync(2000);
  expect(request.mock.calls).toEqual([
    [input],
    [{ operation: "status", jobId: waiting.jobId }],
    [input],
  ]);
  expect(result.mock.calls).toEqual([[waiting], [ready]]);
  expect(error).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  stop();
});

it("disposal ignores a late ready reply and never cancels native work", async () => {
  const pending = deferredSetupReply<ServerOpencodeV2ThreadToolsSetupResult>();
  const request = vi.fn(() => pending.promise);
  const result = vi.fn();
  const error = vi.fn();
  observeOpenCodeSetup(request, input, result, error)();
  pending.resolve(ready);
  await pending.promise;
  expect(result).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledExactlyOnceWith(input);
});

it("bounds a stalled request and ignores success arriving after the deadline", async () => {
  vi.useFakeTimers();
  const pending = deferredSetupReply<ServerOpencodeV2ThreadToolsSetupResult>();
  const result = vi.fn();
  const error = vi.fn();
  observeOpenCodeSetup(() => pending.promise, input, result, error);
  await vi.advanceTimersByTimeAsync(300000);
  expect(error).toHaveBeenCalledOnce();
  pending.resolve(ready);
  await pending.promise;
  expect(result).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["blocked", "failed", "uncertain", "cancelled", "deferred"] as const)(
  "does not start another job when setup is %s",
  async (activationState) => {
    vi.useFakeTimers();
    const value = { ...waiting, activationState };
    const request = vi.fn().mockResolvedValue(value);
    const result = vi.fn();
    observeOpenCodeSetup(request, input, result, vi.fn());
    await vi.advanceTimersByTimeAsync(300000);
    expect(request).toHaveBeenCalledOnce();
    expect(result).toHaveBeenCalledWith(value);
    expect(vi.getTimerCount()).toBe(0);
  },
);
