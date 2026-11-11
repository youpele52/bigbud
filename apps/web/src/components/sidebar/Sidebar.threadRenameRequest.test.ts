import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  THREAD_RENAME_REQUEST_TTL_MS,
  useThreadRenameRequest,
} from "./Sidebar.threadRenameRequest";

const threadId = ThreadId.makeUnsafe("rename-target");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T10:00:00.000Z"));
});
afterEach(() => {
  useThreadRenameRequest.setState({ threadId: null });
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("expires a pending request without any mounted sidebar", () => {
  useThreadRenameRequest.getState().request(threadId);
  const request = useThreadRenameRequest.getState();
  expect(request.expiresAt).toBe(Date.now() + THREAD_RENAME_REQUEST_TTL_MS);
  vi.advanceTimersByTime(THREAD_RENAME_REQUEST_TTL_MS - 1);
  expect(useThreadRenameRequest.getState().threadId).toBe(threadId);
  vi.advanceTimersByTime(1);
  expect(useThreadRenameRequest.getState().threadId).toBeNull();
});

it("a stale timer or consumer cannot erase a newer request for the same thread", () => {
  useThreadRenameRequest.getState().request(threadId);
  const oldId = useThreadRenameRequest.getState().requestId;
  vi.advanceTimersByTime(1_000);
  useThreadRenameRequest.getState().request(threadId);
  const newer = useThreadRenameRequest.getState();
  expect(newer.requestId).toBeGreaterThan(oldId);
  useThreadRenameRequest.getState().consume(oldId);
  vi.advanceTimersByTime(THREAD_RENAME_REQUEST_TTL_MS - 1_000);
  expect(useThreadRenameRequest.getState().threadId).toBe(threadId);
  expect(useThreadRenameRequest.getState().expiresAt).toBe(newer.expiresAt);
  vi.advanceTimersByTime(1_000);
  expect(useThreadRenameRequest.getState().threadId).toBeNull();
});

it("only the current request can be consumed", () => {
  useThreadRenameRequest.getState().request(threadId);
  const oldId = useThreadRenameRequest.getState().requestId;
  const other = ThreadId.makeUnsafe("another-target");
  useThreadRenameRequest.getState().request(other);
  useThreadRenameRequest.getState().consume(oldId);
  expect(useThreadRenameRequest.getState().threadId).toBe(other);
  useThreadRenameRequest.getState().consume(useThreadRenameRequest.getState().requestId);
  expect(useThreadRenameRequest.getState().threadId).toBeNull();
});
